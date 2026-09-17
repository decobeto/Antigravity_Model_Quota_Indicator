const vscode = require('vscode');

class QuotaStatusBar {
  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100 // High priority in status bar
    );
    this.statusBarItem.command = 'antigravityQuota.showDetails';
    this.lastQuotaData = null;
    this.lastUserStatus = null;
  }

  /**
   * Format ISO date string into human readable hours & minutes remaining (e.g. "4h 26m")
   */
  formatTimeRemaining(resetTimeString) {
    if (!resetTimeString) return '';
    const resetDate = new Date(resetTimeString);
    const now = new Date();
    const diffMs = resetDate - now;

    if (diffMs <= 0) return 'Ready!';

    const totalMinutes = Math.floor(diffMs / (1000 * 60));
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;

    if (hours > 24) {
      const days = Math.floor(hours / 24);
      const remHours = hours % 24;
      return `${days}d ${remHours}h`;
    }

    if (hours > 0) {
      return `${hours}h ${mins}m`;
    }

    return `${mins}m`;
  }

  /**
   * Update status bar item text, tooltip, and icons based on quota data
   */
  update(quotaData, userStatus) {
    this.lastQuotaData = quotaData;
    this.lastUserStatus = userStatus;

    if (!quotaData || !quotaData.groups || quotaData.groups.length === 0) {
      this.statusBarItem.text = '$(dashboard) Quota: N/A';
      this.statusBarItem.tooltip = 'Unable to load model quota information.';
      this.statusBarItem.show();
      return;
    }

    const config = vscode.workspace.getConfiguration('antigravityQuota');
    const showModelName = config.get('showModelName', true);
    const showCountdown = config.get('showCountdown', true);

    const parts = [];

    for (const group of quotaData.groups) {
      const h5Bucket = group.buckets?.find(b => b.window === '5h') || group.buckets?.[0];
      const weeklyBucket = group.buckets?.find(b =>
        b.window === 'weekly' ||
        b.window === '7d' ||
        (b.displayName && b.displayName.toLowerCase().includes('weekly'))
      );

      const h5Pct = h5Bucket ? Math.round((h5Bucket.remainingFraction ?? 1) * 100) : 100;
      const weeklyPct = weeklyBucket ? Math.round((weeklyBucket.remainingFraction ?? 1) * 100) : 100;

      // The effective quota is determined by whichever bucket is more restrictive
      let pct = h5Pct;
      let activeBucket = h5Bucket;

      if (weeklyBucket && weeklyPct < h5Pct) {
        pct = weeklyPct;
        activeBucket = weeklyBucket;
      }

      if (!activeBucket) continue;

      const timeStr = this.formatTimeRemaining(activeBucket.resetTime);

      // Contextual status icon per model group
      const groupMinPct = Math.min(h5Pct, weeklyPct);
      let icon = '$(shield)';
      if (groupMinPct <= 20) icon = '$(warning)';
      else if (groupMinPct <= 50) icon = '$(pulse)';

      let groupLabel = group.displayName;
      if (groupLabel.includes('Gemini')) groupLabel = 'Gemini';
      else if (groupLabel.includes('Claude')) groupLabel = 'Claude/GPT';

      let partText = `${icon} `;
      if (showModelName) {
        partText += `${groupLabel}: `;
      }
      partText += `${pct}%`;

      if (showCountdown && timeStr && pct < 100) {
        partText += ` (${timeStr})`;
      }

      parts.push(partText);
    }

    // Set Status Bar Text
    this.statusBarItem.text = parts.join(' | ');

    // Build Markdown Tooltip
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`### ⚡ Antigravity Model Quota\n\n`);

    if (userStatus?.email) {
      md.appendMarkdown(`**Account:** \`${userStatus.email}\`\n\n`);
    }

    for (const group of quotaData.groups) {
      const groupEmoji = group.displayName.includes('Gemini') ? '⚡' : '🤖';
      md.appendMarkdown(`---\n\n#### ${groupEmoji} ${group.displayName}\n`);
      if (group.description) {
        md.appendMarkdown(`*${group.description}*\n\n`);
      }

      md.appendMarkdown(`| Limit Window | Remaining (%) | Reset In |\n`);
      md.appendMarkdown(`| :--- | :---: | :---: |\n`);

      for (const bucket of group.buckets || []) {
        const pct = Math.round((bucket.remainingFraction ?? 1) * 100);
        const timeStr = this.formatTimeRemaining(bucket.resetTime);
        const pctIcon = pct > 50 ? '🟢' : pct > 20 ? '🟡' : '🔴';

        md.appendMarkdown(`| ${bucket.displayName} | ${pctIcon} **${pct}%** | ${timeStr || 'N/A'} |\n`);
      }
      md.appendMarkdown(`\n`);
    }

    md.appendMarkdown(`---\n*Click to refresh or view detailed quota usage.*`);
    this.statusBarItem.tooltip = md;

    this.statusBarItem.show();
  }

  showError(msg) {
    this.statusBarItem.text = `$(error) Quota: Error`;
    this.statusBarItem.tooltip = `Error fetching model quota: ${msg}`;
    this.statusBarItem.show();
  }

  hide() {
    this.statusBarItem.hide();
  }

  dispose() {
    this.statusBarItem.dispose();
  }
}

module.exports = { QuotaStatusBar };
