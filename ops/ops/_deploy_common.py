from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import hcl2  # type: ignore[import-not-found]

from ._utils import repo_root, run_logged


@dataclass(frozen=True)
class AzureContext:
    subscription_id: str
    tenant_id: str


@dataclass(frozen=True)
class Paths:
    root: Path
    bootstrap: Path
    workload: Path


@dataclass(frozen=True)
class BootstrapState:
    resource_group: str
    storage_account: str
    container: str
    blob_key: str


def configure_logging() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")


def resolve_paths() -> Paths:
    root = repo_root()
    stacks = root / "infra" / "terraform" / "stacks"
    return Paths(
        root=root,
        bootstrap=stacks / "00-bootstrap",
        workload=stacks / "20-workload",
    )


def azure_context() -> AzureContext:
    env_sub = os.environ.get("AZURE_SUBSCRIPTION_ID") or os.environ.get(
        "ARM_SUBSCRIPTION_ID"
    )
    env_tenant = os.environ.get("AZURE_TENANT_ID") or os.environ.get("ARM_TENANT_ID")
    if env_sub and env_tenant:
        return AzureContext(subscription_id=env_sub, tenant_id=env_tenant)

    result = run_logged(
        ["az", "account", "show", "--output", "json"],
        capture_output=True,
        echo="on_error",
    )
    data = json.loads(result.stdout)
    return AzureContext(subscription_id=data["id"], tenant_id=data["tenantId"])


def _set_tfvar_value(content: str, key: str, value: str) -> str:
    """
    Update a scalar tfvar assignment in-place, preserving indentation when possible.
    Adds the assignment if the key is missing.
    """
    lines = content.splitlines()
    new_line = f'{key} = "{value}"'
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        lhs = stripped.split("=", 1)[0].strip()
        if lhs == key:
            indent = line[: len(line) - len(line.lstrip())]
            lines[idx] = f"{indent}{new_line}"
            break
    else:
        lines.append(new_line)

    updated = "\n".join(lines)
    if not updated.endswith("\n"):
        updated += "\n"
    return updated


def load_tfvars(tfvars_path: Path) -> dict[str, Any]:
    with tfvars_path.open() as handle:
        return hcl2.load(handle)  # type: ignore[attr-defined]


def ensure_tfvars(
    stack_dir: Path, env: str, subscription_id: str, tenant_id: str
) -> Path:
    target = stack_dir / f"{env}.tfvars"
    example_candidates: Iterable[Path] = (
        stack_dir / f"terraform.tfvars.{env}.example",
        stack_dir / f"{env}.tfvars.example",
        stack_dir / "terraform.tfvars.example",
    )
    example = next((path for path in example_candidates if path.exists()), None)

    if not target.exists():
        if example is None:
            raise FileNotFoundError(
                f"Missing tfvars for env '{env}' and no example found in {stack_dir}"
            )
        target.write_text(example.read_text())
        logging.info("Seeded tfvars for %s from %s", env, example.name)

    content = target.read_text() if target.exists() else ""
    content = _set_tfvar_value(content, "subscription_id", subscription_id)
    content = _set_tfvar_value(content, "tenant_id", tenant_id)
    content = _set_tfvar_value(content, "environment_code", env)
    target.write_text(content)
    logging.info(
        "Updated %s with subscription_id, tenant_id, and environment_code", target.name
    )
    return target


def update_tfvars(tfvars_path: Path, updates: dict[str, str]) -> None:
    content = tfvars_path.read_text() if tfvars_path.exists() else ""
    for key, value in updates.items():
        content = _set_tfvar_value(content, key, value)
    tfvars_path.write_text(content)


def terraform_init(stack_dir: Path, extra_args: list[str] | None = None) -> None:
    args = ["terraform", "init", "-reconfigure"]
    if extra_args:
        args.extend(extra_args)
    run_logged(args, cwd=stack_dir)


def terraform_apply(
    stack_dir: Path,
    tfvars: Path,
    auto_approve: bool = True,
    extra_args: list[str] | None = None,
) -> None:
    apply_cmd = [
        "terraform",
        "apply",
        "-var-file",
        tfvars.name,
    ]
    if auto_approve:
        apply_cmd.append("--auto-approve")
    if extra_args:
        apply_cmd.extend(extra_args)
    run_logged(apply_cmd, cwd=stack_dir)


def terraform_plan(
    stack_dir: Path, tfvars: Path, extra_args: list[str] | None = None
) -> None:
    plan_cmd = [
        "terraform",
        "plan",
        "-var-file",
        tfvars.name,
    ]
    if extra_args:
        plan_cmd.extend(extra_args)
    run_logged(plan_cmd, cwd=stack_dir)


def terraform_output(stack_dir: Path) -> dict[str, str]:
    result = run_logged(
        ["terraform", "output", "-json"], cwd=stack_dir, capture_output=True, echo="on_error"
    )
    return json.loads(result.stdout)


def terraform_init_local(stack_dir: Path, state_path: Path) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)
    run_logged(
        [
            "terraform",
            "init",
            "-reconfigure",
            "-backend-config",
            f"path={state_path}",
        ],
        cwd=stack_dir,
    )


def terraform_init_remote(
    stack_dir: Path,
    *,
    tenant_id: str,
    state_rg: str,
    state_sa: str,
    state_container: str,
    state_key: str,
) -> None:
    run_logged(
        [
            "terraform",
            "init",
            "-reconfigure",
            "-backend-config=use_azuread_auth=true",
            f"-backend-config=tenant_id={tenant_id}",
            f"-backend-config=resource_group_name={state_rg}",
            f"-backend-config=storage_account_name={state_sa}",
            f"-backend-config=container_name={state_container}",
            f"-backend-config=key={state_key}",
        ],
        cwd=stack_dir,
    )


def bootstrap_state_from_outputs(outputs: dict[str, str]) -> BootstrapState:
    def _required(key: str) -> str:
        value = outputs.get(key, {}).get("value")
        if value is None:
            raise KeyError(f"Missing terraform output '{key}'")
        return str(value)

    return BootstrapState(
        resource_group=_required("state_rg_name"),
        storage_account=_required("state_storage_account_name"),
        container=_required("state_container_name"),
        blob_key=_required("state_blob_key"),
    )


def load_bootstrap_state(env: str, paths: Paths, ctx: AzureContext) -> BootstrapState:
    state_path = paths.bootstrap / ".state" / env / "bootstrap.tfstate"
    if not state_path.exists():
        raise FileNotFoundError(
            f"Bootstrap state not found at {state_path}. Run deploy-bootstrap for env '{env}' first."
        )
    os.environ["ARM_SUBSCRIPTION_ID"] = ctx.subscription_id
    os.environ["ARM_TENANT_ID"] = ctx.tenant_id
    terraform_init_local(paths.bootstrap, state_path)
    outputs = terraform_output(paths.bootstrap)
    return bootstrap_state_from_outputs(outputs)


def export_core_tf_env(env: str, ctx: AzureContext) -> None:
    os.environ["TF_VAR_subscription_id"] = ctx.subscription_id
    os.environ["TF_VAR_tenant_id"] = ctx.tenant_id
    os.environ["TF_VAR_environment_code"] = env
    os.environ["ARM_SUBSCRIPTION_ID"] = ctx.subscription_id
    os.environ["ARM_TENANT_ID"] = ctx.tenant_id
