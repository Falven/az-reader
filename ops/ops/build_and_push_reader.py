from __future__ import annotations

from pathlib import Path

from .build_and_push import build_cli


def main(argv: list[str] | None = None) -> int:
    return build_cli(
        argv=argv,
        description="Build and push the az-reader container image to Azure Container Registry.",
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
        tfvars_key="container_image",
    )


if __name__ == "__main__":
    raise SystemExit(main())
