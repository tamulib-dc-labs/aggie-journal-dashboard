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
    this.scope = "single"; // "single" = one journal, "all" = cross-journal aggregate
    this.allData = null; // { publications: [...], totals: {...}, perJournal: [...] }
    this.allSort = { key: "total_views", dir: "desc" };
    this.allFilter = "";
    this.openalexCache = {}; // site name → OpenAlex JSON, or null when not available
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
    const allBtn = `<button class="site-btn ${this.scope === "all" ? "active" : ""}"
             data-scope="all" aria-pressed="${this.scope === "all"}">All Journals</button>`;
    container.innerHTML =
      allBtn +
      this.sites
        .map(
          (site) =>
            `<button class="site-btn ${this.scope === "single" && site.name === this.currentSite ? "active" : ""}"
             data-site="${site.name}" aria-pressed="${this.scope === "single" && site.name === this.currentSite}">${site.title || site.name}</button>`
        )
        .join("");

    container.addEventListener("click", (e) => {
      if (e.target.dataset.scope === "all") {
        this.selectAllJournals();
      } else if (e.target.classList.contains("site-btn")) {
        this.selectSite(e.target.dataset.site);
      }
    });
  }

  selectSite(siteName) {
    this.scope = "single";
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

  selectAllJournals() {
    this.scope = "all";
    document
      .querySelectorAll("#site-selector-container .site-btn")
      .forEach((btn) => {
        const isActive = btn.dataset.scope === "all";
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-pressed", String(isActive));
      });
    this.currentSnapshot = "last-90-days";
    this.renderDateControls();
    this.loadAllJournals();
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
      if (this.scope === "all") this.loadAllJournals();
      else this.loadSnapshot();
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
    this.renderAbout();
    this.activateTab("overview");

    const site = this.sites.find((s) => s.name === this.currentSite);
    const label = this.formatSnapshotLabel(this.currentSnapshot);
    this.announce(`Dashboard updated for ${site?.title || this.currentSite}, ${label} range.`);
  }

  async loadAllJournals() {
    this.showLoading();
    this.renderDateControls();

    const results = await Promise.all(
      this.sites.map(async (site) => {
        let snap =
          site.snapshots?.find((s) => s.label === this.currentSnapshot) ||
          site.snapshots?.find((s) => s.label === "all-time");
        if (!snap) return { site, data: null };
        try {
          const resp = await fetch(`data/${site.directory}/${snap.file}`);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return { site, data: await resp.json() };
        } catch (err) {
          console.error(`All Journals: failed to load ${site.name}:`, err);
          return { site, data: null };
        }
      })
    );

    const publications = [];
    const perJournal = [];
    const totals = {
      journals: 0,
      failed: 0,
      publications: 0,
      total_views: 0,
      pdf_views: 0,
      abstract_views: 0,
      new_submissions: 0,
    };

    for (const { site, data } of results) {
      if (!data || !data.summary) {
        totals.failed++;
        continue;
      }
      totals.journals++;
      const s = data.summary;
      totals.total_views += s.total_view_count || 0;
      totals.pdf_views += s.total_pdf_views || 0;
      totals.abstract_views += s.total_abstract_views || 0;
      totals.new_submissions +=
        s.new_submissions_in_period !== undefined
          ? s.new_submissions_in_period
          : s.total_submissions || 0;

      const pubs = data.publication_stats || [];
      totals.publications += pubs.length;
      for (const p of pubs) {
        publications.push({
          journal: site.title || site.name,
          title: p.title || "",
          authors: p.authors || "",
          total_views: p.total_views || 0,
          pdf_views: p.pdf_views || 0,
          url_published: p.url_published || "",
        });
      }
      perJournal.push({
        journal: site.title || site.name,
        total_views: s.total_view_count || 0,
      });
    }

    this.allData = { publications, perJournal, totals };
    this.allFilter = "";
    this.allSort = { key: "total_views", dir: "desc" };
    this.renderAllJournals();

    this.announce(
      `All Journals view updated, ${this.formatSnapshotLabel(this.currentSnapshot)} range: ` +
        `${totals.publications} publications across ${totals.journals} journals.`
    );
  }

  renderAllJournals() {
    if (!this.allData) return;
    document.getElementById("app").innerHTML = "";
    this.renderTabs();

    const { totals, perJournal } = this.allData;

    const grid = document.getElementById("all-stat-grid");
    if (grid) {
      const cards = [
        { value: this.formatNumber(totals.journals), label: "Journals", variant: "accent" },
        { value: this.formatNumber(totals.publications), label: "Publications", variant: "green" },
        { value: this.formatNumber(totals.total_views), label: "Total Views", sub: `${this.formatNumber(totals.pdf_views)} PDF`, variant: "purple" },
        { value: this.formatNumber(totals.abstract_views), label: "Abstract Views", variant: "orange" },
        { value: this.formatNumber(totals.new_submissions), label: "New Submissions", sub: "in selected range", variant: "accent" },
      ];
      grid.innerHTML = cards
        .map(
          (c) => `
        <div class="stat-card ${c.variant}">
          <div class="stat-value">${c.value}</div>
          <div class="stat-label">${c.label}</div>
          ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ""}
        </div>`
        )
        .join("");
    }

    const chart = document.getElementById("all-journal-chart");
    if (chart) {
      const top = [...perJournal].sort((a, b) => b.total_views - a.total_views).slice(0, 10);
      const maxVal = Math.max(...top.map((j) => j.total_views), 1);
      chart.innerHTML =
        "<h3>Top Journals by Views</h3>" +
        (totals.failed
          ? `<p class="stat-sub">${totals.failed} journal(s) could not be loaded for this range.</p>`
          : "") +
        top
          .map(
            (j) => `
        <div class="chart-bar-row">
          <div class="bar-label" title="${this.escapeHtml(j.journal)}">${this.truncate(this.escapeHtml(j.journal), 25)}</div>
          <div class="chart-bar-track">
            <div class="chart-bar-fill accent" style="width: ${((j.total_views / maxVal) * 100).toFixed(1)}%">${this.formatNumber(j.total_views)}</div>
          </div>
        </div>`
          )
          .join("");
    }

    const filterInput = document.getElementById("all-pub-filter");
    if (filterInput && !filterInput.dataset.wired) {
      filterInput.dataset.wired = "1";
      filterInput.addEventListener("input", (e) => {
        this.allFilter = e.target.value.toLowerCase();
        this.renderAllPublicationsTable();
      });
    }
    document.querySelectorAll("#all-journals-tab th button[data-sort]").forEach((btn) => {
      if (btn.dataset.wired) return;
      btn.dataset.wired = "1";
      btn.addEventListener("click", () => {
        const key = btn.dataset.sort;
        if (this.allSort.key === key) {
          this.allSort.dir = this.allSort.dir === "asc" ? "desc" : "asc";
        } else {
          this.allSort = { key, dir: key === "total_views" ? "desc" : "asc" };
        }
        this.renderAllPublicationsTable();
      });
    });

    this.renderAllPublicationsTable();
    this.activateTab("all-journals");
  }

  renderAllPublicationsTable() {
    const body = document.getElementById("all-pub-table-body");
    if (!body || !this.allData) return;
    const { key, dir } = this.allSort;
    const mult = dir === "asc" ? 1 : -1;

    let rows = this.allData.publications;
    if (this.allFilter) {
      rows = rows.filter(
        (r) =>
          r.title.toLowerCase().includes(this.allFilter) ||
          r.authors.toLowerCase().includes(this.allFilter) ||
          r.journal.toLowerCase().includes(this.allFilter)
      );
    }
    rows = [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * mult;
      return String(av).localeCompare(String(bv)) * mult;
    });

    const total = rows.length;
    const shown = rows.slice(0, 100);
    const countEl = document.getElementById("all-pub-count");
    if (countEl) {
      countEl.textContent =
        total > 100 ? `Showing top 100 of ${this.formatNumber(total)}` : `${this.formatNumber(total)} publication${total === 1 ? "" : "s"}`;
    }

    document.querySelectorAll("#all-journals-tab th[aria-sort]").forEach((th) => {
      const btn = th.querySelector("button[data-sort]");
      th.setAttribute(
        "aria-sort",
        btn && btn.dataset.sort === key ? (dir === "asc" ? "ascending" : "descending") : "none"
      );
    });

    if (shown.length === 0) {
      body.innerHTML = '<tr><td colspan="4" class="loading">No matching publications</td></tr>';
      return;
    }
    body.innerHTML = shown
      .map(
        (r) => `
      <tr>
        <td>${this.escapeHtml(r.journal)}</td>
        <td>${
          r.url_published
            ? `<a href="${r.url_published}" target="_blank" rel="noopener" title="${this.escapeHtml(r.title)}">${this.truncate(this.escapeHtml(r.title), 60)}<span class="visually-hidden"> (opens in a new tab)</span></a>`
            : this.truncate(this.escapeHtml(r.title), 60)
        }</td>
        <td>${this.escapeHtml(r.authors)}</td>
        <td>${this.formatNumber(r.total_views)}</td>
      </tr>`
      )
      .join("");
  }

  announce(message) {
    const region = document.getElementById("live-region");
    if (region) region.textContent = message;
  }

  renderTabs() {
    const container = document.getElementById("main-tabs");
    if (!container) return;
    const tabs =
      this.scope === "all"
        ? [{ id: "all-journals", label: "All Journals" }]
        : [
            { id: "overview", label: "Overview" },
            { id: "publications", label: "Publications" },
            { id: "issues", label: "Issues" },
            { id: "submissions", label: "Submissions" },
            { id: "users", label: "Users" },
            { id: "about", label: "About" },
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

  renderAbout() {
    const container = document.getElementById("about-content");
    if (!container) return;
    const site = this.sites.find((s) => s.name === this.currentSite);
    const title = this.data.site_title || site?.title || this.currentSite;
    const url = this.data.site_url;
    const fetchedAt = this.data.fetched_at;
    const journal = this.data.journal || {};
    const details = [];
    if (journal.issns?.length) {
      details.push(`<dt>ISSN</dt><dd>${journal.issns.map((i) => this.escapeHtml(i)).join(", ")}</dd>`);
    }
    if (journal.doi_prefix) {
      details.push(`<dt>DOI prefix</dt><dd>${this.escapeHtml(journal.doi_prefix)}</dd>`);
    }

    container.innerHTML = `
      <h3>${this.escapeHtml(title)}</h3>
      <p>
        ${
          url
            ? `<a href="${url}" target="_blank" rel="noopener">${this.escapeHtml(url)}<span class="visually-hidden"> (opens in a new tab)</span></a>`
            : "Journal URL not available"
        }
      </p>
      ${details.length ? `<dl class="about-details">${details.join("")}</dl>` : ""}
      <p class="stat-sub">
        Data last updated: ${fetchedAt ? new Date(fetchedAt).toLocaleString() : "unknown"}
      </p>
    `;

    this.renderOpenAlex();
  }

  // --- OpenAlex (About tab) ---

  async loadOpenAlex(siteName) {
    if (siteName in this.openalexCache) return this.openalexCache[siteName];
    let data = null;
    try {
      const resp = await fetch(`data/openalex/${siteName}.json`);
      if (resp.ok) data = await resp.json();
    } catch (err) {
      console.error(`Failed to load OpenAlex data for ${siteName}:`, err);
    }
    this.openalexCache[siteName] = data;
    return data;
  }

  async renderOpenAlex() {
    const container = document.getElementById("openalex-content");
    if (!container) return;
    const siteName = this.currentSite;
    const heading = `<h2 id="openalex-heading" class="section-heading">OpenAlex</h2>`;
    container.innerHTML = heading + '<div class="loading">Loading OpenAlex data…</div>';

    const oa = await this.loadOpenAlex(siteName);
    // The person may have switched journals while this was loading
    if (this.currentSite !== siteName || this.scope !== "single") return;

    if (!oa) {
      container.innerHTML =
        heading +
        `<div class="chart-container"><p>OpenAlex data hasn't been fetched for this journal yet.</p></div>`;
      return;
    }

    const cov = oa.coverage || {};
    if (!oa.source && !(oa.works || []).length) {
      container.innerHTML = heading + `<div class="chart-container">${this.openAlexNotFound(oa)}</div>`;
      return;
    }

    container.innerHTML =
      heading +
      this.openAlexIntro(oa) +
      this.openAlexCards(oa) +
      `<div class="chart-row">
        <div class="chart-container">${this.openAlexCitationsByYear(oa)}</div>
        <div class="chart-container">${this.openAlexMostCited(oa)}</div>
      </div>
      <div class="chart-row">
        <div class="chart-container">${this.openAlexRanked("Top Topics", oa.top_topics, "accent", (n) => n)}</div>
        <div class="chart-container">${this.openAlexRanked("Author Institutions", oa.top_institutions, "green", (n) => n)}</div>
        <div class="chart-container">${this.openAlexRanked("Author Countries", oa.top_countries, "orange", (c) => this.countryName(c))}</div>
      </div>
      <div class="chart-container">${this.openAlexCoverage(oa, cov)}</div>`;
  }

  openAlexNotFound(oa) {
    const issns = oa.issns || [];
    const dois = oa.coverage?.ojs_articles_with_doi || 0;
    if (!issns.length && !dois) {
      return `<p>This journal couldn't be looked up in OpenAlex: no ISSN or article DOIs are recorded for it.</p>
        <p class="stat-sub">Adding an ISSN in the journal's OJS settings, or registering DOIs for its articles, lets OpenAlex data appear here.</p>`;
    }
    const parts = [];
    if (issns.length) {
      parts.push(`OpenAlex has no journal with ISSN ${issns.map((i) => this.escapeHtml(i)).join(" or ")}.`);
    }
    if (dois) {
      parts.push(`None of the journal's ${this.formatNumber(dois)} article DOIs were found in OpenAlex either.`);
    }
    return `<p>${parts.join(" ")}</p>
      <p class="stat-sub">OpenAlex mostly learns about journals through DOIs registered with Crossref, so new journals or journals without DOIs often don't appear yet.</p>`;
  }

  openAlexIntro(oa) {
    const src = oa.source;
    const badges = [];
    if (src?.is_oa) badges.push('<span class="badge">Open access</span>');
    if (src?.is_in_doaj) badges.push('<span class="badge">In DOAJ</span>');
    const fetched = oa.fetched_at ? new Date(oa.fetched_at).toLocaleDateString() : "unknown";
    const sourceLine = src
      ? `Listed in OpenAlex as ${this.externalLink(src.url, src.display_name || src.openalex_id)}${
          src.host_organization ? ` (publisher: ${this.escapeHtml(src.host_organization)})` : ""
        }.`
      : "This journal isn't listed in OpenAlex by ISSN, so the figures below cover only articles matched by DOI.";
    return `<div class="openalex-intro">
        <p>${sourceLine} ${badges.join(" ")}</p>
        <p class="stat-sub">Citation data from <a href="https://openalex.org" target="_blank" rel="noopener">OpenAlex<span class="visually-hidden"> (opens in a new tab)</span></a>, updated ${fetched}.</p>
      </div>`;
  }

  openAlexCards(oa) {
    const t = oa.totals || {};
    const cards = [
      { value: this.formatNumber(t.works), label: "Works Indexed", variant: "accent" },
      { value: this.formatNumber(t.cited_by_count), label: "Citations", variant: "green" },
    ];
    if (t.h_index != null) {
      cards.push({ value: t.h_index, label: "h-index", sub: "h articles with ≥ h citations", variant: "purple" });
    }
    if (t.i10_index != null) {
      cards.push({ value: t.i10_index, label: "i10-index", sub: "articles with ≥ 10 citations", variant: "orange" });
    }
    if (t.two_year_mean_citedness != null) {
      cards.push({
        value: Number(t.two_year_mean_citedness).toFixed(2),
        label: "2-Year Mean Citedness",
        sub: "citations per recent article",
        variant: "accent",
      });
    }
    return `<div class="stat-grid">${cards
      .map(
        (c) => `
      <div class="stat-card ${c.variant}">
        <div class="stat-value">${c.value}</div>
        <div class="stat-label">${c.label}</div>
        ${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ""}
      </div>`
      )
      .join("")}</div>`;
  }

  openAlexCitationsByYear(oa) {
    const title = "<h3>Citations by Year</h3>";
    const thisYear = new Date().getFullYear();
    const years = (oa.counts_by_year || [])
      .filter((y) => y.year > thisYear - 10)
      .sort((a, b) => a.year - b.year);
    if (!years.length || years.every((y) => !y.cited_by_count)) {
      return title + "<p class='loading'>No citation history</p>";
    }
    const maxVal = Math.max(...years.map((y) => y.cited_by_count), 1);
    return (
      title +
      years
        .map(
          (y) => `
        <div class="chart-bar-row">
          <div class="bar-label">${y.year}${y.year === thisYear ? " (so far)" : ""}</div>
          <div class="chart-bar-track">
            <div class="chart-bar-fill green" style="width: ${((y.cited_by_count / maxVal) * 100).toFixed(1)}%">${this.formatNumber(y.cited_by_count)}</div>
          </div>
        </div>`
        )
        .join("")
    );
  }

  openAlexMostCited(oa) {
    const title = "<h3>Most Cited Articles</h3>";
    const works = (oa.works || []).filter((w) => w.cited_by_count > 0).slice(0, 10);
    if (!works.length) return title + "<p class='loading'>No citations recorded yet</p>";
    const ojsUrls = new Map((this.data.publication_stats || []).map((p) => [p.id, p.url_published]));
    const rows = works
      .map((w) => {
        const url =
          (w.ojs_id && ojsUrls.get(w.ojs_id)) ||
          (w.doi ? `https://doi.org/${w.doi}` : `https://openalex.org/${w.openalex_id}`);
        return `<tr>
          <td>${this.externalLink(url, this.truncate(w.title || "Untitled", 60), w.title)}</td>
          <td>${w.year || ""}</td>
          <td class="num">${this.formatNumber(w.cited_by_count)}</td>
        </tr>`;
      })
      .join("");
    return `${title}
      <div class="table-wrapper">
        <table>
          <caption class="visually-hidden">Most cited articles according to OpenAlex</caption>
          <thead><tr><th scope="col">Article</th><th scope="col">Year</th><th scope="col" class="num">Citations</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  openAlexRanked(title, items, variant, labelFn) {
    const head = `<h3>${title}</h3>`;
    if (!items?.length) return head + "<p class='loading'>No data</p>";
    const maxVal = Math.max(...items.map((i) => i.count), 1);
    return (
      head +
      `<p class="stat-sub ranked-note">Number of articles</p>` +
      items
        .map((i) => {
          const label = this.escapeHtml(labelFn(i.name));
          return `
        <div class="chart-bar-row">
          <div class="bar-label" title="${this.escapeAttr(labelFn(i.name))}">${label}</div>
          <div class="chart-bar-track">
            <div class="chart-bar-fill ${variant}" style="width: ${((i.count / maxVal) * 100).toFixed(1)}%">${this.formatNumber(i.count)}</div>
          </div>
        </div>`;
        })
        .join("")
    );
  }

  openAlexCoverage(oa, cov) {
    const title = "<h3>DOI Coverage</h3>";
    const total = cov.ojs_articles_with_doi || 0;
    if (!total) {
      return `${title}<p>No articles in OJS have DOIs, so none could be matched to OpenAlex individually.</p>`;
    }
    const matched = cov.matched_by_doi || 0;
    const pct = ((matched / total) * 100).toFixed(0);
    const missing = oa.unmatched_articles || [];
    const list = missing.length
      ? `<details class="coverage-details">
          <summary>${this.formatNumber(missing.length)} article${missing.length === 1 ? "" : "s"} not found in OpenAlex</summary>
          <ul>${missing
            .map(
              (m) =>
                `<li>${this.escapeHtml(m.title || "Untitled")}: ${this.externalLink(`https://doi.org/${m.doi}`, m.doi)}</li>`
            )
            .join("")}</ul>
        </details>`
      : "";
    return `${title}
      <p>${this.formatNumber(matched)} of ${this.formatNumber(total)} OJS articles with DOIs (${pct}%) are in OpenAlex.</p>
      <div class="chart-bar-track coverage-bar" role="img" aria-label="${pct}% of DOIs found in OpenAlex">
        <div class="chart-bar-fill accent" style="width: ${pct}%">${pct}%</div>
      </div>
      ${list}`;
  }

  externalLink(url, text, title) {
    const safe = /^https?:\/\//i.test(url || "") ? url : null;
    const label = this.escapeHtml(text || url || "");
    if (!safe) return label;
    return `<a href="${this.escapeAttr(safe)}" target="_blank" rel="noopener"${
      title ? ` title="${this.escapeAttr(title)}"` : ""
    }>${label}<span class="visually-hidden"> (opens in a new tab)</span></a>`;
  }

  countryName(code) {
    try {
      this.regionNames ||= new Intl.DisplayNames(["en"], { type: "region" });
      return this.regionNames.of(code) || code;
    } catch {
      return code;
    }
  }

  // --- Utility ---
  formatSnapshotLabel(label) {
    const labels = {
      "all-time": "All Time",
      "current-year": "Current Year",
      "previous-year": "Previous Year",
      "previous-fiscal-year": "Previous Fiscal Year",
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

  escapeAttr(str) {
    return this.escapeHtml(str).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.dashboard = new Dashboard();
});
