/**
 * A small Docker Registry v2 / OCI distribution client for Artifact Registry, used to resolve tags
 * to digests and to stream an image's manifest, config and layer blobs, with no local Docker.
 * Auth: a Google access token from the same credentials as the rest of dockeriser. Artifact
 * Registry accepts it as a bearer token; if it answers 401 with a token realm, the access token is
 * exchanged there with basic auth `oauth2accesstoken:<token>` (what `docker login` does).
 */

import { Readable } from 'node:stream';
import { AuthError, ConfigError, DockeriserError } from './errors.js';

export const MEDIA = {
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
};
const ACCEPT = [MEDIA.ociIndex, MEDIA.dockerList, MEDIA.ociManifest, MEDIA.dockerManifest].join(', ');

/**
 * Split `host/path:tag` or `host/path@sha256:...`.
 * @param {string} ref
 * @returns {{host: string, path: string, tag?: string, digest?: string, repository: string}}
 */
export function parseRef(ref) {
  const [nameTag, digest] = ref.split('@');
  const slash = nameTag.indexOf('/');
  if (slash < 0) throw new ConfigError(`"${ref}" is not a full registry reference.`);
  const host = nameTag.slice(0, slash);
  let rest = nameTag.slice(slash + 1);
  let tag;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { host, path: rest, tag, digest, repository: `${host}/${rest}` };
}

/** Pick the linux/amd64 entry from an index (or the only entry). */
export function pickPlatform(index, { os = 'linux', architecture = 'amd64' } = {}) {
  const entries = (index.manifests || []).filter((m) => m.platform?.os !== 'unknown'); // skip attestations
  const hit = entries.find((m) => m.platform?.os === os && m.platform?.architecture === architecture) || (entries.length === 1 ? entries[0] : null);
  if (!hit) {
    const have = entries.map((m) => `${m.platform?.os}/${m.platform?.architecture}`).join(', ') || 'none';
    throw new ConfigError(`The image has no ${os}/${architecture} variant (it has: ${have}).`, { fix: 'Build it for linux/amd64 (Cloud Build does by default).' });
  }
  return hit;
}

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getAccessToken Google access token.
 * @param {typeof fetch} [opts.fetch]
 */
export function createRegistryClient({ getAccessToken, fetch: doFetch = globalThis.fetch }) {
  const tokens = new Map(); // repository path -> bearer token to use

  async function authed(url, init, repoPath, retried = false) {
    let token = tokens.get(repoPath);
    if (!token) {
      token = await getAccessToken();
      tokens.set(repoPath, token);
    }
    const res = await doFetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }, redirect: 'follow' });
    if (res.status !== 401 || retried) return res;
    const challenge = res.headers.get('www-authenticate') || '';
    const realm = challenge.match(/realm="([^"]+)"/)?.[1];
    if (!realm) return res;
    const service = challenge.match(/service="([^"]+)"/)?.[1];
    const params = new URLSearchParams();
    if (service) params.set('service', service);
    params.set('scope', `repository:${repoPath}:pull`);
    const access = await getAccessToken();
    const basic = Buffer.from(`oauth2accesstoken:${access}`).toString('base64');
    const tr = await doFetch(`${realm}?${params}`, { headers: { Authorization: `Basic ${basic}` } });
    if (!tr.ok) return res;
    const body = await tr.json();
    tokens.set(repoPath, body.token || body.access_token);
    return authed(url, init, repoPath, true);
  }

  function fail(res, what, ref) {
    if (res.status === 401 || res.status === 403) {
      return new AuthError(`Artifact Registry refused to ${what} ${ref} (HTTP ${res.status}).`, { fix: 'Check that dockeriser is signed in (`dockeriser doctor`) and the image is in your repo.' });
    }
    if (res.status === 404) return new ConfigError(`${ref} was not found in Artifact Registry.`, { fix: 'Build it first (`dockeriser build`), or check the image name and tag.' });
    return new DockeriserError(`Artifact Registry answered HTTP ${res.status} when asked to ${what} ${ref}.`);
  }

  async function getManifest(ref, reference) {
    const r = parseRef(ref);
    const url = `https://${r.host}/v2/${r.path}/manifests/${reference}`;
    const res = await authed(url, { headers: { Accept: ACCEPT } }, r.path);
    if (!res.ok) throw fail(res, 'read the manifest of', `${r.repository}:${reference}`);
    const text = await res.text();
    const json = JSON.parse(text);
    const digest = res.headers.get('docker-content-digest') || (reference.startsWith('sha256:') ? reference : null);
    return { json, mediaType: json.mediaType || res.headers.get('content-type'), digest };
  }

  return {
    /** Resolve `<repo>:<tag>` to its manifest digest. */
    async resolveDigest(ref) {
      const r = parseRef(ref);
      const url = `https://${r.host}/v2/${r.path}/manifests/${r.tag || 'latest'}`;
      const res = await authed(url, { method: 'HEAD', headers: { Accept: ACCEPT } }, r.path);
      if (!res.ok) throw fail(res, 'find', `${r.repository}:${r.tag || 'latest'}`);
      const digest = res.headers.get('docker-content-digest');
      if (!digest) throw new DockeriserError(`Artifact Registry did not return a digest for ${ref}.`);
      return digest;
    },

    /**
     * The single-platform image manifest for `<repo>@<digest>` (an index is resolved to linux/amd64).
     * @returns {Promise<{repository: string, digest: string, manifestDigest: string, config: {digest: string, size: number}, layers: Array<{digest: string, size: number, mediaType: string}>}>}
     */
    async imageManifest(ref) {
      const r = parseRef(ref);
      let m = await getManifest(ref, r.digest || r.tag || 'latest');
      const top = m.digest;
      if (m.mediaType === MEDIA.ociIndex || m.mediaType === MEDIA.dockerList || (m.json.manifests && !m.json.layers)) {
        const entry = pickPlatform(m.json);
        m = await getManifest(ref, entry.digest);
        m.digest = entry.digest;
      }
      if (!m.json.config || !Array.isArray(m.json.layers)) throw new DockeriserError(`${ref} has an image manifest dockeriser does not understand.`);
      return {
        repository: r.repository,
        digest: top,
        manifestDigest: m.digest,
        config: { digest: m.json.config.digest, size: Number(m.json.config.size) },
        layers: m.json.layers.map((l) => ({ digest: l.digest, size: Number(l.size), mediaType: l.mediaType })),
      };
    },

    /** A Node readable stream of one blob (registry redirects to storage are followed). */
    async blobStream(repository, digest) {
      const r = parseRef(repository);
      const url = `https://${r.host}/v2/${r.path}/blobs/${digest}`;
      const res = await authed(url, { headers: {} }, r.path);
      if (!res.ok) throw fail(res, 'download blob', `${r.repository}@${digest}`);
      return Readable.fromWeb(res.body);
    },
  };
}
