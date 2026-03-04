#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const nodeCrypto = require("node:crypto");

const LICENSED_DIR = path.resolve(__dirname, "..", "licensed");
const GEOLITE_TAG = process.env.GEOLITE_GITHUB_TAG || "2026.03.01";
const GEOLITE_FILENAMES = ["GeoLite2-ASN.mmdb", "GeoLite2-City.mmdb", "GeoLite2-Country.mmdb"];
const SOURCE_HAN_FILENAME = "SourceHanSansSC-Regular.otf";
const SOURCE_HAN_URL =
  process.env.SOURCE_HAN_SC_REGULAR_URL ||
  "https://raw.githubusercontent.com/adobe-fonts/source-han-sans/release/OTF/SimplifiedChinese/SourceHanSansSC-Regular.otf";
const SOURCE_HAN_SHA256 = `${process.env.SOURCE_HAN_SC_REGULAR_SHA256 || ""}`.trim().toLowerCase();
const REQUEST_HEADERS = { "user-agent": "datacontrol/1.0", accept: "application/vnd.github+json" };
type GeoLiteAsset = { url: string; digest: string; };

const sha256 = (content: Buffer) => nodeCrypto.createHash("sha256").update(content).digest("hex");

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed request (${response.status}): ${url}`);
  }
  return response.json();
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: REQUEST_HEADERS });
  if (!response.ok) {
    throw new Error(`Failed request (${response.status}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  try {
    fs.mkdirSync(LICENSED_DIR, { recursive: true });

    const releaseUrl = `https://api.github.com/repos/P3TERX/GeoLite.mmdb/releases/tags/${GEOLITE_TAG}`;
    const release = await fetchJson(releaseUrl);
    const assets = new Map<string, GeoLiteAsset>(
      (release.assets || []).map((asset: any): [string, GeoLiteAsset] => [
        String(asset.name || ""),
        {
          url: String(asset.browser_download_url || ""),
          digest: `${asset.digest || ""}`.replace(/^sha256:/, "").toLowerCase(),
        },
      ])
    );

    for (const filename of GEOLITE_FILENAMES) {
      const asset = assets.get(filename);
      if (!asset?.url || !asset?.digest) {
        throw new Error(`Release ${GEOLITE_TAG} is missing ${filename} or digest metadata.`);
      }

      const filePath = path.join(LICENSED_DIR, filename);
      const hashPath = `${filePath}.sha256`;
      const hasValidLocalFile =
        fs.existsSync(filePath) && sha256(fs.readFileSync(filePath)) === asset.digest;

      if (!hasValidLocalFile) {
        process.stdout.write(`Downloading ${filename}...\n`);
        const content = await fetchBuffer(asset.url);
        const digest = sha256(content);
        if (digest !== asset.digest) {
          throw new Error(`Checksum mismatch for ${filename}.`);
        }
        fs.writeFileSync(filePath, content);
      }

      fs.writeFileSync(hashPath, `${asset.digest}\n`);
    }

    const sourceHanPath = path.join(LICENSED_DIR, SOURCE_HAN_FILENAME);
    const sourceHanHashPath = `${sourceHanPath}.sha256`;
    let sourceHanValid = false;
    if (fs.existsSync(sourceHanPath) && fs.existsSync(sourceHanHashPath)) {
      const sourceHanActualHash = sha256(fs.readFileSync(sourceHanPath));
      const sourceHanExpectedHash = fs.readFileSync(sourceHanHashPath, "utf8").trim().toLowerCase();
      sourceHanValid = sourceHanActualHash === sourceHanExpectedHash;
    }

    if (!sourceHanValid) {
      process.stdout.write(`Downloading ${SOURCE_HAN_FILENAME}...\n`);
      const sourceHanContent = await fetchBuffer(SOURCE_HAN_URL);
      const sourceHanDigest = sha256(sourceHanContent);
      if (SOURCE_HAN_SHA256 && SOURCE_HAN_SHA256 !== sourceHanDigest) {
        throw new Error(`Checksum mismatch for ${SOURCE_HAN_FILENAME}.`);
      }
      fs.writeFileSync(sourceHanPath, sourceHanContent);
      fs.writeFileSync(sourceHanHashPath, `${sourceHanDigest}\n`);
    }
  } catch (err: unknown) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
