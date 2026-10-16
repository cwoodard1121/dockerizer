/**
 * Google client construction, loaded lazily so --help, --dry-run and config errors stay fast
 * and tests never load gRPC. Credentials come from Application Default Credentials.
 */

/**
 * @param {{project: string}} opts
 * @returns {Promise<{cloudBuild: import('@google-cloud/cloudbuild').CloudBuildClient,
 *   storage: import('@google-cloud/storage').Storage}>}
 */
export async function createClients({ project }) {
  const [{ CloudBuildClient }, { Storage }] = await Promise.all([
    import('@google-cloud/cloudbuild'),
    import('@google-cloud/storage'),
  ]);
  return {
    cloudBuild: new CloudBuildClient(),
    storage: new Storage({ projectId: project }),
  };
}
