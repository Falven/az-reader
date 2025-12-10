from __future__ import annotations

import argparse
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from shutil import copy2, copytree
from typing import Iterable, Iterator

from ._deploy_common import (
    azure_context,
    ensure_tfvars,
    load_tfvars,
    resolve_paths,
    update_tfvars,
)
from ._utils import derive_image_tag, ensure, repo_root, run_logged


def build_and_push(
    *,
    env: str,
    target: str,
    dockerfile: Path,
    build_context: Path,
    include_paths: Iterable[Path],
    local_docker: bool,
    tfvars_key: str,
    registry_login_server: str | None = None,
    tfvars_path: Path | None = None,
) -> str:
    ensure(["terraform", "az"])
    if local_docker:
        ensure(["docker"])

    paths = resolve_paths()
    ctx = azure_context()
    tfvars = (
        tfvars_path
        if tfvars_path is not None
        else ensure_tfvars(paths.workload, env, ctx.subscription_id, ctx.tenant_id)
    )
    tfvars_data = _safe_load_tfvars(tfvars)

    login_server = _registry_login_server(
        registry_login_server,
        tfvars_data,
    )
    registry_name = _registry_name_from_login_server(login_server)

    template = repo_root() / "acr-build.yaml"
    if not template.exists():
        raise FileNotFoundError(f"acr-build.yaml not found at {template}")

    image_repo = os.environ.get("AZ_READER_IMAGE_REPOSITORY_PREFIX", "az-reader")
    image_tag = os.environ.get("IMAGE_TAG") or derive_image_tag(paths.root)
    full_image = f"{login_server}/{image_repo}:{image_tag}"
    remote_image = f"{image_repo}:{image_tag}"

    for rel_path in include_paths:
        if not (paths.root / rel_path).exists():
            raise FileNotFoundError(
                f"Build context path missing: {rel_path}. Did you run the app build?"
            )

    with _staged_context(
        paths.root, template, include_paths, build_context, dockerfile, target
    ) as (context_root, dockerfile_rel, build_context_rel):
        if local_docker:
            if login_server.endswith(".azurecr.io"):
                _acr_docker_login(registry_name)
            _docker_build_and_push(
                image=full_image,
                dockerfile=context_root / dockerfile_rel,
                context_dir=context_root / build_context_rel,
            )
        else:
            _acr_run_build(
                registry=registry_name,
                template=context_root / "acr-build.yaml",
                image=remote_image,
                dockerfile=dockerfile_rel,
                build_context=build_context_rel,
                workdir=context_root,
            )

    update_tfvars(
        tfvars,
        {
            "registry_login_server": login_server,
            tfvars_key: full_image,
        },
    )

    print(full_image)
    return full_image


def build_cli(
    *,
    argv: list[str] | None,
    description: str,
    target: str,
    dockerfile: Path,
    build_context: Path,
    include_paths: Iterable[Path],
    tfvars_key: str,
) -> int:
    parser = argparse.ArgumentParser(
        prog=f"build-and-push-{target}",
        description=description,
    )
    parser.add_argument("env", help="Environment code (e.g. dev, prod)")
    parser.add_argument(
        "--local-docker", action="store_true", help="Build locally with docker"
    )
    parser.add_argument(
        "--registry-login-server",
        help="Registry login server (e.g. myacr.azurecr.io). Overrides tfvars/env.",
    )
    parser.add_argument(
        "--tfvars",
        type=Path,
        help="Optional path to tfvars to update (defaults to stacks/20-workload/<env>.tfvars)",
    )
    args = parser.parse_args(argv)

    build_and_push(
        env=args.env,
        target=target,
        dockerfile=dockerfile,
        build_context=build_context,
        include_paths=include_paths,
        local_docker=args.local_docker,
        registry_login_server=args.registry_login_server,
        tfvars_key=tfvars_key,
        tfvars_path=args.tfvars,
    )
    return 0


def _safe_load_tfvars(tfvars: Path) -> dict:
    try:
        return load_tfvars(tfvars)
    except Exception:
        return {}


def _registry_login_server(
    override: str | None,
    tfvars_data: dict,
) -> str:
    value = (
        override
        or os.environ.get("AZ_READER_REGISTRY_LOGIN_SERVER")
        or os.environ.get("REGISTRY_LOGIN_SERVER")
        or str(tfvars_data.get("registry_login_server", "") or "").strip()
    )
    if not value or "<" in value or value.strip() == "":
        raise RuntimeError(
            "registry_login_server is required. Set it in tfvars, pass --registry-login-server, "
            "or export AZ_READER_REGISTRY_LOGIN_SERVER."
        )
    return value


def _registry_name_from_login_server(login_server: str) -> str:
    return login_server.split(".")[0]


def _acr_docker_login(registry: str) -> None:
    run_logged(["az", "acr", "login", "--name", registry])


def _docker_build_and_push(image: str, dockerfile: Path, context_dir: Path) -> None:
    run_logged(
        [
            "docker",
            "build",
            "--platform",
            "linux/amd64",
            "-t",
            image,
            "-f",
            str(dockerfile),
            str(context_dir),
        ],
        capture_output=False,
    )
    run_logged(["docker", "push", image], capture_output=False)


def _acr_run_build(
    *,
    registry: str,
    template: Path,
    image: str,
    dockerfile: Path,
    build_context: Path,
    workdir: Path,
) -> None:
    template_path = template.relative_to(workdir)
    run_logged(
        [
            "az",
            "acr",
            "run",
            "-f",
            template_path.as_posix(),
            "--registry",
            registry,
            "--set",
            f"image={image}",
            "--set",
            f"dockerfile={dockerfile.as_posix()}",
            "--set",
            "platform=linux/amd64",
            "--set",
            f"context={build_context.as_posix()}",
            str(workdir),
        ],
        capture_output=True,
    )


def _copy_into_context(root: Path, destination_root: Path, rel_path: Path) -> None:
    source = root / rel_path
    destination = destination_root / rel_path
    destination.parent.mkdir(parents=True, exist_ok=True)

    if source.is_dir():
        copytree(source, destination, dirs_exist_ok=True)
    else:
        copy2(source, destination)


@contextmanager
def _staged_context(
    root: Path,
    template: Path,
    include_paths: Iterable[Path],
    build_context: Path,
    dockerfile: Path,
    target: str,
) -> Iterator[tuple[Path, Path, Path]]:
    with tempfile.TemporaryDirectory(prefix=f"{target}-ctx-") as tmpdir:
        context_root = Path(tmpdir)
        copy2(template, context_root / "acr-build.yaml")
        for rel_path in include_paths:
            _copy_into_context(root, context_root, rel_path)

        build_context_abs = context_root / build_context
        if not build_context_abs.exists():
            raise FileNotFoundError(
                f"Build context not found for {target}: {build_context_abs}"
            )

        yield context_root, dockerfile, build_context
