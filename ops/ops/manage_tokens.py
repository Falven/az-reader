from __future__ import annotations

import argparse
import secrets
import string
from typing import Any, Dict, List, Tuple

from ._deploy_common import (
    azure_context,
    configure_logging,
    ensure_tfvars,
    load_tfvars,
    resolve_paths,
)
from ._utils import run_logged


def _run_az(command: list[str]) -> str:
    result = run_logged(command, capture_output=True, echo="on_error")
    return result.stdout


def _load_tokens(vault: str, secret: str) -> Dict[str, str]:
    try:
        output = _run_az(
            [
                "az",
                "keyvault",
                "secret",
                "show",
                "--vault-name",
                vault,
                "--name",
                secret,
                "--query",
                "value",
                "--output",
                "tsv",
            ]
        ).strip()
    except Exception:
        return {}
    if not output:
        return {}
    tokens: Dict[str, str] = {}
    entries = output.replace("\n", ";").replace(",", ";").split(";")
    legacy_counter = 1
    for entry in entries:
        entry = entry.strip()
        if not entry:
            continue
        if ":" in entry:
            name, value = entry.split(":", 1)
            name = name.strip()
            value = value.strip()
            if name and value:
                tokens[name] = value
        else:
            placeholder = f"legacy-{legacy_counter}"
            tokens[placeholder] = entry
            legacy_counter += 1
    return tokens


def _save_tokens(vault: str, secret: str, tokens: Dict[str, str]) -> None:
    entries = [f"{name}:{value}" for name, value in sorted(tokens.items())]
    value = ";".join(entries)
    _run_az(
        [
            "az",
            "keyvault",
            "secret",
            "set",
            "--vault-name",
            vault,
            "--name",
            secret,
            "--value",
            value,
        ]
    )


def _generate_token(length: int = 64) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _parse_name_value(raw: str) -> Tuple[str, str]:
    if ":" in raw:
        name, value = raw.split(":", 1)
    elif "=" in raw:
        name, value = raw.split("=", 1)
    else:
        raise ValueError("Use name:token or name=token when adding tokens.")
    name = name.strip()
    value = value.strip()
    if not name or not value:
        raise ValueError("Token name and value must be non-empty.")
    _validate_component("name", name)
    _validate_component("value", value)
    return name, value


def _validate_component(label: str, component: str) -> None:
    if ":" in component or ";" in component:
        raise ValueError(f"Token {label} cannot contain ':' or ';'")


def _load_tfvars_data(env: str) -> dict[str, Any]:
    paths = resolve_paths()
    ctx = azure_context()
    tfvars = ensure_tfvars(paths.workload, env, ctx.subscription_id, ctx.tenant_id)
    try:
        return load_tfvars(tfvars)
    except Exception as exc:
        raise RuntimeError(f"Failed to read tfvars at {tfvars}") from exc


def _resolve_targets(
    *, env: str, vault_override: str | None, secret_override: str | None
) -> tuple[str, str]:
    tfvars_data = _load_tfvars_data(env)
    vault = vault_override or str(tfvars_data.get("key_vault_name", "") or "").strip()
    if vault == "":
        raise RuntimeError(
            "Key Vault name is required. Set key_vault_name in tfvars or pass --vault-name."
        )
    secret = secret_override or "self-host-tokens"
    return vault, secret


def manage_tokens(
    *,
    vault: str,
    secret: str,
    add: List[str],
    remove: List[str],
    generate: List[str],
    list_only: bool,
) -> None:
    tokens = _load_tokens(vault, secret)

    generated: Dict[str, str] = {}
    for item in generate:
        if item.isdigit():
            count = int(item)
            for idx in range(count):
                suffix = idx + 1
                name = f"generated-{suffix}"
                while name in tokens:
                    suffix += 1
                    name = f"generated-{suffix}"
                token = _generate_token()
                tokens[name] = token
                generated[name] = token
        else:
            name = item.strip()
            if not name:
                continue
            _validate_component("name", name)
            if name in tokens:
                raise ValueError(f"Token name already exists: {name}")
            token = _generate_token()
            tokens[name] = token
            generated[name] = token

    for token in add:
        name, value = _parse_name_value(token)
        tokens[name] = value

    for token in remove:
        tokens.pop(token, None)

    if list_only and not add and not remove and not generate:
        for name, value in sorted(tokens.items()):
            print(f"{name}:{value}")
        return

    _save_tokens(vault, secret, tokens)

    print(f"vault={vault}")
    print(f"secret={secret}")
    print(f"total_tokens={len(tokens)}")
    if generated:
        print("generated:")
        for name, value in generated.items():
            print(f"  {name}:{value}")
    if add:
        added_names = sorted(_parse_name_value(t)[0] for t in add)
        print(f"added_names={','.join(added_names)}")
    if remove:
        print(f"removed_names={','.join(sorted(remove))}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Manage self-host tokens in Key Vault."
    )
    parser.add_argument(
        "--env",
        default="dev",
        help="Environment code (e.g. dev, prod). Used to locate tfvars for defaults.",
    )
    parser.add_argument(
        "--vault-name",
        help="Key Vault name. Defaults to key_vault_name in tfvars for --env.",
    )
    parser.add_argument(
        "--secret-name",
        help=(
            "Secret name to store token list (stored as name:token;name:token). Defaults to self-host-tokens."
        ),
    )
    parser.add_argument(
        "--add",
        action="append",
        default=[],
        help="Add a token in name:token form (can be repeated).",
    )
    parser.add_argument(
        "--remove",
        action="append",
        default=[],
        help="Token name to remove (can be repeated).",
    )
    parser.add_argument(
        "--generate",
        action="append",
        default=[],
        help="Generate a token. Pass a name (e.g. --generate alice). Pass a number to generate N named tokens (generated-1...N). Can be repeated.",
    )
    parser.add_argument(
        "--list",
        action="store_true",
        help="List tokens without modifying (ignored if add/remove/generate provided).",
    )
    args = parser.parse_args(argv)

    configure_logging()
    vault, secret = _resolve_targets(
        env=args.env,
        vault_override=args.vault_name,
        secret_override=args.secret_name,
    )
    manage_tokens(
        vault=vault,
        secret=secret,
        add=args.add,
        remove=args.remove,
        generate=args.generate,
        list_only=args.list,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
