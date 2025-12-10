from __future__ import annotations

import argparse
import logging

from ._deploy_common import (
    AzureContext,
    azure_context,
    configure_logging,
    export_core_tf_env,
    ensure_tfvars,
    resolve_paths,
    terraform_apply,
    terraform_init_local,
    terraform_plan,
)
from ._utils import ensure


def deploy_bootstrap(env: str) -> None:
    configure_logging()
    ensure(["az", "terraform"])
    ctx: AzureContext = azure_context()
    export_core_tf_env(env, ctx)
    paths = resolve_paths()
    tfvars = ensure_tfvars(paths.bootstrap, env, ctx.subscription_id, ctx.tenant_id)

    backend_state_path = paths.bootstrap / ".state" / env / "bootstrap.tfstate"
    backend_state_path.parent.mkdir(parents=True, exist_ok=True)

    logging.info("==> 00-bootstrap (%s)", env)
    terraform_init_local(paths.bootstrap, backend_state_path.resolve())
    terraform_plan(paths.bootstrap, tfvars)
    terraform_apply(paths.bootstrap, tfvars, auto_approve=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Deploy the 00-bootstrap stack for the given environment."
    )
    parser.add_argument(
        "env",
        help="Environment code (e.g. dev, prod). Used to select <env>.tfvars files.",
    )
    args = parser.parse_args(argv)

    deploy_bootstrap(args.env)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
