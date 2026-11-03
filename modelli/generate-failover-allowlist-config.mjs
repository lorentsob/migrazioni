import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA256 = /^[a-f0-9]{64}$/;
const STATIC_PREFIX = '/_next/static/';

function isCanonicalStaticPath(path) {
  if (typeof path !== 'string' || !path.startsWith(STATIC_PREFIX) || path.includes('?') || path.includes('#') || path.includes('\\')) {
    return false;
  }
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return false; }
  if (decoded !== path) return false;
  try {
    const parsed = new URL(`https://assets.invalid${path}`);
    if (parsed.pathname !== path || parsed.search || parsed.hash) return false;
  } catch { return false; }
  const suffixSegments = path.slice(STATIC_PREFIX.length).split('/');
  return suffixSegments.length > 0 && suffixSegments.every(segment => segment && segment !== '.' && segment !== '..');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requiredVerification(verification) {
  if (!verification || typeof verification !== 'object') {
    throw new TypeError('verification options are required');
  }
  const { expectedManifestSha256, expectedRevision, expectedAssetCount } = verification;
  if (typeof expectedManifestSha256 !== 'string' || !SHA256.test(expectedManifestSha256.toLowerCase())) {
    throw new TypeError('expectedManifestSha256 must be a SHA256 hex string');
  }
  if (typeof expectedRevision !== 'string' || expectedRevision.length === 0) {
    throw new TypeError('expectedRevision is required');
  }
  if (!Number.isInteger(expectedAssetCount) || expectedAssetCount < 1) {
    throw new TypeError('expectedAssetCount must be a positive integer');
  }
  return {
    expectedManifestSha256: expectedManifestSha256.toLowerCase(),
    expectedRevision,
    expectedAssetCount,
  };
}

function parseManifest(manifestText) {
  if (typeof manifestText !== 'string' || manifestText.length === 0) {
    throw new TypeError('manifest must be a non-empty JSON string');
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new Error(`manifest JSON is invalid: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('manifest must be a JSON object');
  }
  if (manifest.version !== 1) throw new Error('unsupported manifest version');
  if (typeof manifest.revision !== 'string' || manifest.revision.length === 0) {
    throw new Error('manifest revision is missing');
  }
  if (!Array.isArray(manifest.files)) throw new Error('manifest files must be an array');
  return manifest;
}

function validatedEntries(files) {
  const seen = new Set();
  const entries = files.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`manifest file ${index} is invalid`);
    const { path, size, sha256: fileSha256 } = entry;
    if (!isCanonicalStaticPath(path)) {
      throw new Error(`manifest file ${index} has an invalid static path`);
    }
    if (seen.has(path)) throw new Error(`manifest contains duplicate path: ${path}`);
    seen.add(path);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`manifest file ${path} has an invalid size`);
    if (typeof fileSha256 !== 'string' || !SHA256.test(fileSha256)) {
      throw new Error(`manifest file ${path} has an invalid SHA256`);
    }
    return { path, size, sha256: fileSha256 };
  });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Validate a build manifest against independently supplied release evidence and
 * return a Worker-ready explicit asset allowlist. This function never changes
 * the production Worker configuration; callers decide where to write it.
 */
export function buildAllowlistConfig(manifestText, verification) {
  const checked = requiredVerification(verification);
  const actualManifestSha256 = sha256(manifestText);
  if (actualManifestSha256 !== checked.expectedManifestSha256) {
    throw new Error(`manifest SHA256 mismatch: expected ${checked.expectedManifestSha256}, got ${actualManifestSha256}`);
  }

  const manifest = parseManifest(manifestText);
  if (manifest.revision !== checked.expectedRevision) {
    throw new Error(`manifest revision mismatch: expected ${checked.expectedRevision}, got ${manifest.revision}`);
  }
  if (manifest.files.length !== checked.expectedAssetCount) {
    throw new Error(`manifest asset count mismatch: expected ${checked.expectedAssetCount}, got ${manifest.files.length}`);
  }

  const entries = validatedEntries(manifest.files);
  return {
    schema: 'failover-allowlist/v1',
    manifestVersion: manifest.version,
    revision: manifest.revision,
    manifestSha256: actualManifestSha256,
    assetCount: entries.length,
    standbyAssets: entries.map(({ path }) => path),
    assetSha256: Object.fromEntries(entries.map(({ path, sha256: fileSha256 }) => [path, fileSha256])),
  };
}

async function verifyAssetFiles(config, assetsRoot) {
  const root = resolve(assetsRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error('assets root must not be a symlink');
  for (const [assetPath, expectedSha256] of Object.entries(config.assetSha256)) {
    const filePath = resolve(root, `.${assetPath}`);
    const rel = relative(root, filePath);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`asset path escapes assets root: ${assetPath}`);
    let current = root;
    for (const component of rel.split(sep)) {
      if (!component) continue;
      current = join(current, component);
      const componentInfo = await lstat(current);
      if (componentInfo.isSymbolicLink()) {
        if (current === filePath) throw new Error(`asset must not be a symlink: ${assetPath}`);
        throw new Error(`asset path includes symlink: ${assetPath}`);
      }
    }
    const info = await lstat(filePath);
    if (!info.isFile()) throw new Error(`asset is not a regular file: ${assetPath}`);
    const content = await readFile(filePath);
    if (content.length !== info.size) throw new Error(`asset size changed while reading: ${assetPath}`);
    const actual = sha256(content);
    if (actual !== expectedSha256) throw new Error(`asset SHA256 mismatch: ${assetPath}`);
  }
}

function parseArgs(args) {
  const values = {};
  const valueOptions = new Set([
    '--manifest', '--output', '--expected-revision', '--expected-manifest-sha256',
    '--expected-asset-count', '--assets-root',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!valueOptions.has(option) || index + 1 >= args.length || args[index + 1].startsWith('--')) {
      throw new Error(`invalid or incomplete option: ${option}`);
    }
    if (values[option]) throw new Error(`duplicate option: ${option}`);
    values[option] = args[index + 1];
    index += 1;
  }
  for (const option of ['--manifest', '--output', '--expected-revision', '--expected-manifest-sha256', '--expected-asset-count']) {
    if (!values[option]) throw new Error(`missing required option: ${option}`);
  }
  if (!/^\d+$/.test(values['--expected-asset-count'])) throw new Error('expected asset count must be an integer');
  return values;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const manifestText = await readFile(options['--manifest'], 'utf8');
  const config = buildAllowlistConfig(manifestText, {
    expectedManifestSha256: options['--expected-manifest-sha256'],
    expectedRevision: options['--expected-revision'],
    expectedAssetCount: Number(options['--expected-asset-count']),
  });
  if (options['--assets-root']) await verifyAssetFiles(config, options['--assets-root']);
  await writeFile(options['--output'], `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o644, flag: 'wx',
  });
  return config;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(config => {
    process.stdout.write(JSON.stringify({
      output: process.argv[process.argv.indexOf('--output') + 1],
      revision: config.revision,
      assetCount: config.assetCount,
      manifestSha256: config.manifestSha256,
    }) + '\n');
  }).catch(error => {
    process.stderr.write(`failover allowlist generation failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
