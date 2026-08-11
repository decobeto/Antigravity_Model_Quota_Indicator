const vscode = require('vscode');
const { QuotaService } = require('./src/quotaService');
const { QuotaStatusBar } = require('./src/statusBar');

let quotaService = null;
let statusBar = null;
let pollTimer = null;

/**
 * Extension activation entry point
 */
async function activate(context) {
  console.log('[Antigravity Quota Extension] Activating quota status extension...');

  quotaService = new QuotaService();
  statusBar = new QuotaStatusBar();

  // Register commands
  const refreshCmd = vscode.commands.registerCommand('antigravityQuota.refresh', async () => {
    await fetchAndUpdateQuota(true);
  });

  const detailsCmd = vscode.commands.registerCommand('antigravityQuota.showDetails', async () => {
    await showQuotaQuickPick();
  });

  context.subscriptions.push(refreshCmd);
  context.subscriptions.push(detailsCmd);
  context.subscriptions.push(statusBar);

  // Listen to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('antigravityQuota')) {
        setupPollingTimer();
        fetchAndUpdateQuota(false);
      }
    })
  );

  // Initial fetch and setup polling timer
  await fetchAndUpdateQuota(false);
  setupPollingTimer();
}

/**
 * Fetch quota data and update status bar
 */
async function fetchAndUpdateQuota(showNotification = false) {
  try {
    const quotaData = await quotaService.fetchQuotaSummary();
    const userStatus = await quotaService.fetchUserStatus();

    statusBar.update(quotaData, userStatus);

    if (showNotification) {
      vscode.window.showInformationMessage('Antigravity model quotas refreshed successfully!');
    }
  } catch (err) {
    console.error('[Antigravity Quota Extension] Error fetching quota:', err);
    statusBar.showError(err.message || 'Language Server connection failed');

    if (showNotification) {
      vscode.window.showErrorMessage(`Error fetching Antigravity quota: ${err.message}`);
    }
  }
}

/**
 * Configure background polling interval
 */
function setupPollingTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  const config = vscode.workspace.getConfiguration('antigravityQuota');
  const intervalSec = config.get('refreshInterval', 60);

  if (intervalSec > 0) {
    pollTimer = setInterval(() => {
      fetchAndUpdateQuota(false);
    }, intervalSec * 1000);
  }
}

/**
 * Show QuickPick dialog with detailed quota breakdown
 */
async function showQuotaQuickPick() {
  if (!statusBar.lastQuotaData) {
    vscode.window.showWarningMessage('Fetching quota information...');
    await fetchAndUpdateQuota(true);
    return;
  }

  const quotaData = statusBar.lastQuotaData;
  const items = [];

  for (const group of quotaData.groups || []) {
    const emoji = group.displayName.includes('Gemini') ? '⚡' : '🤖';

    // Separator item without raw codicon strings
    items.push({
      label: `${emoji} ${group.displayName}`,
      kind: vscode.QuickPickItemKind.Separator
    });

    for (const bucket of group.buckets || []) {
      const pct = Math.round((bucket.remainingFraction ?? 1) * 100);
      const timeStr = statusBar.formatTimeRemaining(bucket.resetTime);
      const circleIcon = pct > 50 ? '$(circle-large-filled)' : pct > 20 ? '$(warning)' : '$(error)';

      items.push({
        label: `${circleIcon} ${bucket.displayName}: ${pct}%`,
        description: timeStr ? `Resets in ${timeStr}` : '',
        detail: group.description || ''
      });
    }
  }

  items.push({
    label: '$(sync) Refresh Quotas Now',
    action: 'refresh'
  });

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Antigravity IDE Model Quota Usage'
  });

  if (selected && selected.action === 'refresh') {
    await fetchAndUpdateQuota(true);
  }
}

/**
 * Extension deactivation
 */
function deactivate() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

module.exports = {
  activate,
  deactivate
};
