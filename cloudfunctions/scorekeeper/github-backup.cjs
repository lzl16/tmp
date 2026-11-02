// A narrow Actions-write token is configured only in the cloud function's
// environment. The workflow uses its own short-lived GITHUB_TOKEN to commit.
function createBackupDispatcher({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 1000 } = {}) {
  return async (game) => {
    const repository = env.GITHUB_BACKUP_REPOSITORY;
    const token = env.GITHUB_BACKUP_TOKEN;
    if (!repository || !token) return { status: 'not_configured' };
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^g_(?:[a-f0-9]{32}|legacy_[a-f0-9]{32})$/.test(game?.id || '') || game.status !== 'finished') {
      return { status: 'pending', reason: 'configuration' };
    }
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/workflows/backup-records.yml/dispatches`, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'five-player-scorekeeper',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: env.GITHUB_BACKUP_BRANCH || 'main', inputs: { trigger_game: game.id, trigger_version: String(game.version) } }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Never include response bodies, tokens, or player information in logs.
      return response.ok
        ? { status: 'queued', repository }
        : { status: 'pending', reason: `github_${response.status}` };
    } catch {
      // A timeout can follow an accepted dispatch. Repeated runs are harmless:
      // workflows serialize and only commit when the exported data has changed.
      return { status: 'pending', reason: 'connection' };
    }
  };
}

module.exports = { createBackupDispatcher };
