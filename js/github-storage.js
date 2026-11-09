// GitHubStorage — Manages all data via GitHub API
// Files stored in GitHub repo, served via raw.githubusercontent.com
// Admin sets credentials once in localStorage

class GitHubStorage {
  constructor() {
    this.config = this.loadConfig();
  }

  loadConfig() {
    try {
      return JSON.parse(localStorage.getItem('gh_config') || 'null');
    } catch { return null; }
  }

  saveConfig(config) {
    this.config = config;
    localStorage.setItem('gh_config', JSON.stringify(config));
  }

  isConfigured() {
    return !!(this.config && this.config.owner && this.config.repo && this.config.token);
  }

  getRawBaseUrl() {
    if (!this.config) return '';
    return `https://raw.githubusercontent.com/${this.config.owner}/${this.config.repo}/${this.config.branch || 'main'}`;
  }

  getApiBase() {
    return 'https://api.github.com';
  }

  getHeaders(includeContentType = false) {
    const token = (this.config && this.config.token) ? this.config.token.trim() : '';
    // Fine-grained PATs (github_pat_*) must use Bearer; classic tokens also accept Bearer
    const authPrefix = token.startsWith('github_pat_') ? 'Bearer' : 'token';
    const headers = {
      'Authorization': `${authPrefix} ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    };
    if (includeContentType) {
      headers['Content-Type'] = 'application/json';
    }
    return headers;
  }

  // Get current portals.json from GitHub
  async getPortalsJson() {
    try {
      // If configured, try raw GitHub first
      if (this.isConfigured()) {
        const url = `${this.getRawBaseUrl()}/data/portals.json?t=${Date.now()}`;
        const res = await fetch(url);
        if (res.ok) return await res.json();
      }
      // Fallback to relative path (works on Netlify)
      const res = await fetch(`/data/portals.json?t=${Date.now()}`);
      if (res.ok) return await res.json();
      return { portals: [], models: [] };
    } catch {
      return { portals: [], models: [] };
    }
  }

  // Get file SHA (needed for updates)
  async getFileSha(path) {
    try {
      const { owner, repo, branch } = this.config;
      const res = await fetch(
        `${this.getApiBase()}/repos/${owner}/${repo}/contents/${path}?ref=${branch || 'main'}`,
        { headers: this.getHeaders(false) }
      );
      if (!res.ok) return null;
      const data = await res.json();
      return data.sha;
    } catch { return null; }
  }

  // Upload/update a file to GitHub repo
  async uploadFile(path, content, message) {
    // content should be base64 string
    const { owner, repo, branch } = this.config;
    const sha = await this.getFileSha(path);
    const body = {
      message: message || `Upload ${path}`,
      content: content,
      branch: branch || 'main',
    };
    if (sha) body.sha = sha;

    const res = await fetch(
      `${this.getApiBase()}/repos/${owner}/${repo}/contents/${path}`,
      {
        method: 'PUT',
        headers: this.getHeaders(true),
        body: JSON.stringify(body)
      }
    );
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || 'GitHub upload failed');
    }
    return await res.json();
  }

  // Upload 3D model file
  async uploadModel(file, metadata) {
    // Convert file to base64
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);

    const filename = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const path = `models/${filename}`;

    await this.uploadFile(path, base64, `Add model: ${metadata.name}`);

    // Return model metadata with GitHub raw URL
    const modelMeta = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      name: metadata.name,
      format: file.name.split('.').pop().toLowerCase(),
      description: metadata.description || '',
      filename: filename,
      path: path,
      url: `${this.getRawBaseUrl()}/${path}`,
      createdAt: new Date().toISOString()
    };

    // Update portals.json to include this model
    const data = await this.getPortalsJson();
    data.models = data.models || [];
    data.models.push(modelMeta);
    await this.savePortalsJson(data, `Add model metadata: ${metadata.name}`);

    return modelMeta;
  }

  // Save portals.json to GitHub
  async savePortalsJson(data, message) {
    const json = JSON.stringify(data, null, 2);
    const base64 = btoa(unescape(encodeURIComponent(json)));
    await this.uploadFile('data/portals.json', base64, message || 'Update portals.json');
  }

  // Portal CRUD
  async getAllModels() {
    const data = await this.getPortalsJson();
    return data.models || [];
  }

  async getAllPortals() {
    const data = await this.getPortalsJson();
    return data.portals || [];
  }

  async savePortal(portal) {
    const data = await this.getPortalsJson();
    data.portals = data.portals || [];
    const existing = data.portals.findIndex(p => p.id === portal.id);
    if (existing >= 0) {
      data.portals[existing] = { ...data.portals[existing], ...portal, updatedAt: new Date().toISOString() };
    } else {
      portal.id = portal.id || (Date.now().toString(36) + Math.random().toString(36).slice(2));
      portal.createdAt = new Date().toISOString();
      data.portals.push(portal);
    }
    await this.savePortalsJson(data, `Save portal: ${portal.name}`);
    return portal;
  }

  async deletePortal(id) {
    const data = await this.getPortalsJson();
    data.portals = (data.portals || []).filter(p => p.id !== id);
    await this.savePortalsJson(data, `Delete portal: ${id}`);
  }

  async deleteModel(id) {
    const data = await this.getPortalsJson();
    data.models = (data.models || []).filter(m => m.id !== id);
    await this.savePortalsJson(data, `Delete model: ${id}`);
  }

  // Test connection with timeout and explicit error messages
  async testConnection() {
    if (!this.isConfigured()) throw new Error('Konfigurasi belum lengkap. Mohon isi Username, Nama Repo, dan Token.');
    const { owner, repo } = this.config;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

    try {
      const res = await fetch(
        `${this.getApiBase()}/repos/${owner}/${repo}`,
        {
          headers: this.getHeaders(false),
          signal: controller.signal
        }
      );
      clearTimeout(timeoutId);

      if (res.status === 404) {
        throw new Error(`Repositori "${owner}/${repo}" tidak ditemukan di GitHub. Pastikan nama repositori dan username persis sama (case-sensitive) dan repositori sudah dibuat di GitHub.`);
      }
      if (res.status === 401) {
        throw new Error('Token tidak valid (401 Bad credentials). Pastikan token disalin lengkap dari GitHub.');
      }
      if (res.status === 403) {
        throw new Error('Akses ditolak (403 Forbidden). Token mungkin tidak memiliki izin: Repository permissions → Contents (Read & write).');
      }
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.message || `GitHub error: HTTP ${res.status}`);
      }
      return await res.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('Koneksi timeout (lebih dari 10 detik). Periksa koneksi internet Anda atau coba lagi.');
      }
      throw err;
    }
  }
}

window.GitHubStorage = new GitHubStorage();
