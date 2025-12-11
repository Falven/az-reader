from __future__ import annotations

import argparse
import logging
from pathlib import Path

from ._deploy_common import (
    AzureContext,
    azure_context,
    configure_logging,
    ensure_tfvars,
    export_core_tf_env,
    load_bootstrap_state,
    resolve_paths,
    terraform_apply,
    terraform_init_remote,
    terraform_output,
    terraform_plan,
    update_tfvars,
)
from ._utils import ensure
from .build_and_push import build_and_push


def deploy_workload(
    env: str,
    extra: list[str],
    *,
    local_docker: bool,
    registry_login_server: str | None,
) -> None:
    configure_logging()
    ensure(["az", "terraform"])
    ctx: AzureContext = azure_context()
    export_core_tf_env(env, ctx)
    paths = resolve_paths()
    tfvars = ensure_tfvars(paths.workload, env, ctx.subscription_id, ctx.tenant_id)

    build_and_push(
        env=env,
        target="az-reader",
        dockerfile=Path("Dockerfile"),
        build_context=Path("."),
        include_paths=[
            Path("Dockerfile"),
            Path("package.json"),
            Path("package-lock.json"),
            Path("build"),
            Path("public"),
            Path("licensed"),
        ],
        local_docker=local_docker,
        registry_login_server=registry_login_server,
        tfvars_key="container_image",
        tfvars_path=tfvars,
    )

    bootstrap_state = load_bootstrap_state(env, paths, ctx)
    update_tfvars(
        tfvars,
        {
            "state_resource_group_name": bootstrap_state.resource_group,
            "state_storage_account_name": bootstrap_state.storage_account,
            "state_container_name": bootstrap_state.container,
            "state_blob_key": bootstrap_state.blob_key,
        },
    )

    logging.info("==> 20-workload (%s)", env)
    terraform_init_remote(
        paths.workload,
        tenant_id=ctx.tenant_id,
        state_rg=bootstrap_state.resource_group,
        state_sa=bootstrap_state.storage_account,
        state_container=bootstrap_state.container,
        state_key=bootstrap_state.blob_key,
    )
    terraform_plan(paths.workload, tfvars, extra)
    terraform_apply(paths.workload, tfvars, True, extra)
    _log_app_endpoints(paths.workload)


def _log_app_endpoints(workload_path: Path) -> None:
    outputs = terraform_output(workload_path)

    def _val(key: str) -> str | None:
        node = outputs.get(key, {})
        if isinstance(node, dict):
            value = node.get("value")
            return str(value) if value is not None else None
        return None

    crawl_fqdn = _val("crawl_container_app_fqdn")
    search_fqdn = _val("search_container_app_fqdn")

    def _normalize(url: str | None) -> str | None:
        if url is None:
            return None
        return url if url.startswith("http") else f"https://{url}"

    logging.info("==> Deployment outputs")
    if crawl_fqdn:
        logging.info("Crawl app:  %s", f"{_normalize(crawl_fqdn)}/")
    if search_fqdn:
        logging.info("Search app: %s", f"{_normalize(search_fqdn)}/search")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build, push, and deploy the 20-workload stack."
    )
    parser.add_argument(
        "env",
        help="Environment code (e.g. dev, prod). Used to select <env>.tfvars files.",
    )
    parser.add_argument(
        "--local-docker",
        action="store_true",
        help="Build with local Docker instead of ACR build.",
    )
    parser.add_argument(
        "--registry-login-server",
        help="Registry login server (e.g. myacr.azurecr.io). Overrides tfvars/env.",
    )
    args, extra = parser.parse_known_args(argv)

    registry_override = args.registry_login_server
    local_docker = args.local_docker
    cleaned_extra: list[str] = []
    skip_next = False
    for idx, token in enumerate(extra):
        if skip_next:
            skip_next = False
            continue
        if token == "--local-docker":
            local_docker = True
            continue
        if token == "--registry-login-server":
            if idx + 1 < len(extra):
                registry_override = extra[idx + 1]
                skip_next = True
            continue
        cleaned_extra.append(token)

    deploy_workload(
        args.env,
        cleaned_extra,
        local_docker=local_docker,
        registry_login_server=registry_override,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
