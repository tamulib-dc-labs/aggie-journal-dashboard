/**
 * OJS Dashboard — Static Site Frontend
 * Vanilla JS, no framework. Loads data from local JSON files in /data/.
 */
class Dashboard {
  constructor() {
    this.sites = [];
    this.currentSite = null;
    this.currentSnapshot = "last-90-days";
    this.data = null;
    this.init();
  }

  async init() {
    await this.fetchSites();
    if (this.sites.length === 0) {
      document.getElementById("app").innerHTML =
        '<div class="error-msg">No sites configured</div>';
      return;
    }
    this.currentSite = this.sites[0].name;
    this.renderSiteSelector();
    this.renderDateControls();
    await this.loadSnapshot();
  }

  async fetchSites() {
    try {
      const resp = await fetch("data/sites.json");
      const index = await resp.json();
      this.sites = index.sites;
      this.fetchedAt = index.fetched_at;
      const updatedTimeEl = document.getElementById("updated-time");
      if (updatedTimeEl) {
        updatedTimeEl.textContent = "Data fetched: " + new Date(this.fetchedAt).toLocaleString();
      }
    } catch (err) {
      console.error("Failed to fetch sites index:", err);
      document.getElementById("app").innerHTML =
        '<div class="error-msg">Failed to load sites: ' + err.message + "</div>";
    }
  }

  renderSiteSelector() {
    const container = document.getElementById("site-selector-container");
    if (!container) return;
    container.innerHTML = this.sites
      .map(
        (site) =>
          `<button class="site-btn ${site.name === this.currentSite ? "active" : ""}"
             data-site="${site.name}" aria-pressed="${site.name === this.currentSite}">${site.title || site.name}</button>`
      )
      .join("");

    container.addEventListener("click", (e) => {
      if (e.target.classList.contains("site-btn")) {
        this.selectSite(e.target.dataset.site);
      }
    });
  }

  selectSite(siteName) {
    this.currentSite = siteName;
    document
      .querySelectorAll("#site-selector-container .site-btn")
      .forEach((btn) => {
        const isActive = btn.dataset.site === siteName;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-pressed", String(isActive));
      });
    this.currentSnapshot = "last-90-days";
    this.renderDateControls();
    this.loadSnapshot();
  }

  renderDateControls() {
    const site = this.sites.find((s) => s.name === this.currentSite);
    if (!site) return;
    const container = document.getElementById("date-controls-container");
    if (!container) return;

    const snapshots = site.snapshots || [{ label: "all-time", file: "snapshot.json" }];
    const options = snapshots
      .map(
        (s) =>
          `<option value="${s.label}" ${s.label === this.currentSnapshot ? "selected" : ""}>${this.formatSnapshotLabel(s.label)}</option>`
      )
      .join("");

    container.innerHTML = `
      <div id="date-controls">
        <label for="snapshot-select">Time range:</label>
        <select id="snapshot-select">${options}</select>
      </div>
    `;

    document.getElementById("snapshot-select").addEventListener("change", (e) => {
      this.currentSnapshot = e.target.value;
      this.loadSnapshot();
    });
  }

  async loadSnapshot() {
    this.showLoading();
    const site = this.sites.find((s) => s.name === this.currentSite);
    if (!site) return;

    // Build the URL for the snapshot file, falling back to all-time if the
    // current range (e.g. the last-90-days default) isn't available for this site
    let snapshot = site.snapshots?.find((s) => s.label === this.currentSnapshot);
    if (!snapshot && this.currentSnapshot !== "all-time") {
      snapshot = site.snapshots?.find((s) => s.label === "all-time");
      if (snapshot) {
        this.currentSnapshot = "all-time";
        this.renderDateControls();
      }
    }
    if (!snapshot) {
      document.getElementById("app").innerHTML =
        '<div class="error-msg">Snapshot not found</div>';
      return;
    }

    const url = `data/${site.directory}/${snapshot.file}`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      this.data = await resp.json();
      this.render();
    } catch (err) {
      console.error("Failed to load snapshot:", err);
      document.getElementById("app").innerHTML =
        '<div class="error-msg">Failed to load data: ' + err.message + "</div>";
    }
  }

  showLoading() {
    document.getElementById("app").innerHTML = '<div class="loading">Loading...</div>';
    // Hide tab contents
    document.querySelectorAll(".tab-content").forEach((tc) => tc.classList.remove("active"));
  }

  render() {
    if (!this.data || !this.data.summary) return;
    document.getElementById("app").innerHTML = "";
    this.renderTabs();
    this.renderSummaryCards();
    this.renderPublicationChart();
    this.renderIssueChart();
    this.renderSubmissionBars();
    this.renderTopPublications();
    this.renderTopIssues();
    this.renderSubmissionsTable();
    this.renderUserRoles();
    this.activateTab("overview");

    const site = this.sites.find((s) => s.name === this.currentSite);
    const label = this.formatSnapshotLabel(this.currentSnapshot);
    this.announce(`Dashboard updated for ${site?.title || this.currentSite}, ${label} range.`);
  }

  announce(message) {
    const region = document.getElementById("live-region");
    if (region) region.textContent = message;
  }

  renderTabs() {
    const container = document.getElementById("main-tabs");
    if (!container) return;
    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "publications", label: "Publications" },
      { id: "issues", label: "Issues" },
      { id: "submissions", label: "Submissions" },
      { id: "users", label: "Users" },
    ];
    container.innerHTML = tabs
      .map(
        (t, i) => `
      <button class="tab ${i === 0 ? "active" : ""}" id="tab-${t.id}" role="tab"
        aria-selected="${i === 0}" aria-controls="${t.id}-tab" tabindex="${i === 0 ? "0" : "-1"}"
        data-tab="${t.id}">${t.label}</button>`
      )
      .join("");

    container.addEventListener("click", (e) => {
      if (e.target.classList.contains("tab")) {
        this.activateTab(e.target.dataset.tab);
        e.target.focus();
      }
    });

    container.addEventListener("keydown", (e) => {
      if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
      const tabButtons = [...container.querySelectorAll(".tab")];
      const currentIndex = tabButtons.indexOf(document.activeElement);
      if (currentIndex === -1) return;
      let newIndex;
      if (e.key === "ArrowRight") newIndex = (currentIndex + 1) % tabButtons.length;
      else if (e.key === "ArrowLeft") newIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
      else if (e.key === "Home") newIndex = 0;
      else newIndex = tabButtons.length - 1;
      e.preventDefault();
      tabButtons[newIndex].focus();
      this.activateTab(tabButtons[newIndex].dataset.tab);
    });
  }

  activateTab(tabId) {
    document.querySelectorAll("#main-tabs .tab").forEach((t) => {
      const selected = t.dataset.tab === tabId;
      t.classList.toggle("active", selected);
      t.setAttribute("aria-selected", String(selected));
      t.setAttribute("tabindex", selected ? "0" : "-1");
    });
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    document.getElementById(`${tabId}-tab`)?.classList.add("active");
  }

  renderSummaryCards() {
    const s = this.data.summary;
    const isAllTime = !this.data.date_start && !this.data.date_end;
    const newSubLabel = isAllTime
      ? { value: s.total_submissions, label: "Total Submissions", sub: `${s.published_submissions} published`, variant: "accent" }
      : { value: s.new_submissions_in_period !== undefined ? s.new_submissions_in_period : s.total_submissions, label: "New Submissions", sub: `in selected range`, variant: "accent" };
    const newIssueLabel = isAllTime
      ? { value: s.total_issues, label: "Total Issues", sub: `${s.published_issues} published`, variant: "green" }
      : { value: s.new_issues_in_period !== undefined ? s.new_issues_in_period : s.total_issues, label: "New Issues", sub: `in selected range`, variant: "green" };

    const cards = [
      newSubLabel,
      newIssueLabel,
      { value: this.formatNumber(s.total_view_count), label: "Total Views", sub: `${this.formatNumber(s.total_pdf_views)} PDF`, variant: "purple" },
      { value: this.formatNumber(s.total_abstract_views), label: "Abstract Views", variant: "orange" },
      { value: s.total_users, label: "Total Users", variant: "accent" },
    ];
    const container = document.getElementById("stat-grid");
    if (!container) return;
    container.innerHTML = cards
      .map(
        (c) => `
      <div class="stat-card ${c.variant}">
        <div class="stat-value">${c.value}</div>
        <div class="stat-label">${c.label}</div>
        ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ""}
      </div>`
      )
      .join("");

    // "New This Period" widget (separate from the cards above)
    const newSubEl = document.getElementById("new-submissions");
    if (newSubEl) {
      newSubEl.textContent = this.formatNumber(
        s.new_submissions_in_period !== undefined ? s.new_submissions_in_period : s.total_submissions
      );
    }
    const newIssueEl = document.getElementById("new-issues");
    if (newIssueEl) {
      newIssueEl.textContent = this.formatNumber(
        s.new_issues_in_period !== undefined ? s.new_issues_in_period : s.total_issues
      );
    }
  }

  renderPublicationChart() {
    const pubs = this.data.publication_stats || [];
    const container = document.getElementById("pub-chart");
    if (!container || pubs.length === 0) {
      if (container) container.innerHTML = "<h3>Top Publications by Views</h3><p class='loading'>No data</p>";
      return;
    }
    const top = [...pubs].sort((a, b) => b.total_views - a.total_views).slice(0, 8);
    const maxVal = Math.max(...top.map((p) => p.total_views), 1);
    container.innerHTML = `
      <h3>Top Publications by Views</h3>
      ${top
        .map(
          (p) => `
        <div class="chart-bar-row">
          <div class="bar-label" title="${this.escapeHtml(p.title)}">${this.truncate(p.title, 25)}</div>
          <div class="chart-bar-track">
            <div class="chart-bar-fill accent" style="width: ${(
              (p.total_views / maxVal) *
              100
            ).toFixed(1)}%">${p.total_views}</div>
          </div>
        </div>`
        )
        .join("")}
    `;
  }

  renderIssueChart() {
    const issues = this.data.issue_stats || [];
    const container = document.getElementById("issue-chart");
    if (!container || issues.length === 0) {
      if (container) container.innerHTML = "<h3>Issue Views</h3><p class='loading'>No data</p>";
      return;
    }
    const maxVal = Math.max(...issues.map((i) => i.total_views), 1);
    container.innerHTML = `
      <h3>Issue Views</h3>
      ${issues
        .map(
          (i) => `
        <div class="chart-bar-row">
          <div class="bar-label" title="${i.identification}">${i.identification}</div>
          <div class="chart-bar-track">
            <div class="chart-bar-fill green" style="width: ${(
              (i.total_views / maxVal) *
              100
            ).toFixed(1)}%">${i.total_views}</div>
          </div>
        </div>`
        )
        .join("")}
    `;
  }

  renderSubmissionBars() {
    const statuses = this.data.submission_status_breakdown || {};
    const total = Object.values(statuses).reduce((a, b) => a + b, 0);
    const container = document.getElementById("submission-bars");
    if (!container || total === 0) {
      if (container) container.innerHTML = "<h3>Submission Status</h3><p class='loading'>No data</p>";
      return;
    }

    const statusColors = {
      Draft: "draft",
      Queued: "queued",
      Published: "published",
      Declined: "declined",
      Stalled: "stalled",
    };

    container.innerHTML = `
      <h3>Submission Status</h3>
      <div class="flow-bar-container">
        ${Object.entries(statuses)
          .map(([status, count]) => {
            const color = statusColors[status] || "draft";
            const pct = ((count / total) * 100).toFixed(1);
            return `
            <div class="flow-bar">
              <div class="flow-bar-label">${status}</div>
              <div class="flow-bar-track">
                <div class="flow-bar-fill ${color}" style="width: ${pct}%">${count} (${pct}%)</div>
              </div>
            </div>`;
          })
          .join("")}
      </div>
    `;
  }

  renderTopPublications() {
    const pubs = this.data.publication_stats || [];
    const container = document.getElementById("pub-table-body");
    if (!container) return;
    if (pubs.length === 0) {
      container.innerHTML = '<tr><td colspan="6" class="loading">No publication data</td></tr>';
      return;
    }
    container.innerHTML = pubs
      .map(
        (p) => `
      <tr>
        <td>${p.id || ""}</td>
        <td>${
          p.url_published
            ? `<a href="${p.url_published}" target="_blank" rel="noopener" title="${this.escapeHtml(p.title)}">${this.truncate(this.escapeHtml(p.title), 40)}<span class="visually-hidden"> (opens in a new tab)</span></a>`
            : this.truncate(this.escapeHtml(p.title), 40)
        }</td>
        <td>${p.authors || ""}</td>
        <td>${this.formatNumber(p.abstract_views)}</td>
        <td>${this.formatNumber(p.galley_views)}</td>
        <td>${this.formatNumber(p.total_views)}</td>
      </tr>`
      )
      .join("");
  }

  renderTopIssues() {
    const issues = this.data.issue_stats || [];
    const container = document.getElementById("issue-table-body");
    if (!container) return;
    if (issues.length === 0) {
      container.innerHTML = '<tr><td colspan="5" class="loading">No issue data</td></tr>';
      return;
    }
    container.innerHTML = issues
      .map(
        (i) => `
      <tr>
        <td><a href="${i.url || "#"}" target="_blank" rel="noopener">${i.identification || ""}<span class="visually-hidden"> (opens in a new tab)</span></a></td>
        <td>Vol ${i.volume || ""} No ${i.number || ""} (${i.year || ""})</td>
        <td>${this.formatNumber(i.total_views)}</td>
        <td>${this.formatNumber(i.toc_views)}</td>
        <td>${this.formatNumber(i.issue_galley_views)}</td>
      </tr>`
      )
      .join("");
  }

  renderSubmissionsTable() {
    const submissions = this.data.submissions || [];
    const container = document.getElementById("submission-table-body");
    if (!container) return;
    if (submissions.length === 0) {
      container.innerHTML = '<tr><td colspan="6" class="loading">No submissions</td></tr>';
      return;
    }
    container.innerHTML = submissions
      .map(
        (s) => `
      <tr>
        <td>${s.id || ""}</td>
        <td>${s.status_label || ""}</td>
        <td>${s.stage_label || ""}</td>
        <td>${s.date_submitted || ""}</td>
        <td>${s.date_last_activity || ""}</td>
        <td>${s.status === 3 && s.url_published ? `<a href="${s.url_published}" target="_blank" rel="noopener" aria-label="View published submission ${s.id}">View<span class="visually-hidden"> (opens in a new tab)</span></a>` : ""}</td>
      </tr>`
      )
      .join("");
  }

  renderUserRoles() {
    const roles = this.data.user_stats || [];
    const container = document.getElementById("user-table-body");
    if (!container) return;

    // Filter to role entries (id is integer)
    const roleEntries = roles.filter((u) => typeof u.id === "number" && u.id > 0);
    if (roleEntries.length === 0) {
      container.innerHTML = '<tr><td colspan="2" class="loading">No user data</td></tr>';
      return;
    }

    const total = roleEntries.reduce((sum, r) => sum + (r.value || 0), 0);
    container.innerHTML = roleEntries
      .map(
        (r) => `
      <tr>
        <td>${r.name || ""}</td>
        <td>
          <div class="chart-bar-track" style="display: inline-block; width: 150px; vertical-align: middle;">
            <div class="chart-bar-fill orange" style="width: ${total > 0 ? (r.value / total) * 100 : 0}%">
              ${r.value}
            </div>
          </div>
        </td>
      </tr>`
      )
      .join("");
  }

  // --- Utility ---
  formatSnapshotLabel(label) {
    const labels = {
      "all-time": "All Time",
      "current-year": "Current Year",
      "previous-year": "Previous Year",
      "last-90-days": "Last 90 Days",
      "last-30-days": "Last 30 Days",
      "last-7-days": "Last 7 Days",
      "custom": "Custom Range",
    };
    return labels[label] || label;
  }

  formatNumber(n) {
    if (!n) return 0;
    return parseInt(n).toLocaleString();
  }

  truncate(str, len) {
    if (!str) return "";
    return str.length > len ? str.substring(0, len) + "…" : str;
  }

  escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.dashboard = new Dashboard();
});
