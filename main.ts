// main.ts
import { serve } from "https://deno.land/std@0.182.0/http/server.ts";
import { format } from "https://deno.land/std@0.182.0/datetime/mod.ts";

// ==================== Type Definitions ====================

interface ApiKey {
  id: string;
  key: string;
}

interface ApiUsageData {
  id: string;
  key: string;
  startDate: string;
  endDate: string;
  orgTotalTokensUsed: number;
  totalAllowance: number;
  usedRatio: number;
}

interface ApiErrorData {
  id: string;
  key: string;
  error: string;
}

type ApiKeyResult = ApiUsageData | ApiErrorData;

interface UsageTotals {
  total_orgTotalTokensUsed: number;
  total_totalAllowance: number;
  totalRemaining: number;
}

interface AggregatedResponse {
  update_time: string;
  total_count: number;
  totals: UsageTotals;
  data: ApiKeyResult[];
}

interface ApiResponse {
  usage: {
    startDate: number;
    endDate: number;
    standard: {
      orgTotalTokensUsed: number;
      totalAllowance: number;
      usedRatio: number;
    };
  };
}

interface BatchImportResult {
  success: boolean;
  added: number;
  skipped: number;
}

// ==================== Configuration ====================

const CONFIG = {
  PORT: 8000,
  API_ENDPOINT: 'https://app.factory.ai/api/organization/members/chat-usage',
  USER_AGENT: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  TIMEZONE_OFFSET_HOURS: 8, // Beijing time
  KEY_MASK_PREFIX_LENGTH: 4,
  KEY_MASK_SUFFIX_LENGTH: 4,
  AUTO_REFRESH_INTERVAL_SECONDS: 60, // Set auto-refresh interval to 60 seconds
  EXPORT_PASSWORD: Deno.env.get("EXPORT_PASSWORD") || "admin123", // Default password for key export
} as const;

// ==================== Server State and Caching (NEW) ====================

class ServerState {
  private cachedData: AggregatedResponse | null = null;
  private lastError: string | null = null;
  private isUpdating = false;

  getData = () => this.cachedData;
  getError = () => this.lastError;
  isCurrentlyUpdating = () => this.isUpdating;
  
  updateCache(data: AggregatedResponse) {
    this.cachedData = data;
    this.lastError = null;
    this.isUpdating = false;
  }

  setError(errorMessage: string) {
    this.lastError = errorMessage;
    this.isUpdating = false;
  }
  
  startUpdate() {
    this.isUpdating = true;
  }
}

const serverState = new ServerState();


// ==================== Database Initialization ====================

const kv = await Deno.openKv();

// ==================== Database Operations ====================

async function getAllKeys(): Promise<ApiKey[]> {
  const keys: ApiKey[] = [];
  const entries = kv.list<string>({ prefix: ["api_keys"] });

  for await (const entry of entries) {
    const id = entry.key[1] as string;
    keys.push({ id, key: entry.value });
  }

  return keys;
}

async function addKey(id: string, key: string): Promise<void> {
  await kv.set(["api_keys", id], key);
}

async function deleteKey(id: string): Promise<void> {
  await kv.delete(["api_keys", id]);
}

async function apiKeyExists(key: string): Promise<boolean> {
  const keys = await getAllKeys();
  return keys.some(k => k.key === key);
}

// ==================== Utility Functions ====================

function maskApiKey(key: string): string {
  if (key.length <= CONFIG.KEY_MASK_PREFIX_LENGTH + CONFIG.KEY_MASK_SUFFIX_LENGTH) {
    return `${key.substring(0, CONFIG.KEY_MASK_PREFIX_LENGTH)}...`;
  }
  return `${key.substring(0, CONFIG.KEY_MASK_PREFIX_LENGTH)}...${key.substring(key.length - CONFIG.KEY_MASK_SUFFIX_LENGTH)}`;
}

function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp && timestamp !== 0) return 'N/A';

  try {
    return new Date(timestamp).toISOString().split('T')[0];
  } catch {
    return 'Invalid Date';
  }
}

function getBeijingTime(): Date {
  return new Date(Date.now() + CONFIG.TIMEZONE_OFFSET_HOURS * 60 * 60 * 1000);
}

function createJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createErrorResponse(message: string, status = 500): Response {
  return createJsonResponse({ error: message }, status);
}

// HTML content is embedded as a template string
const HTML_CONTENT = `  
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>API 余额监控看板</title>  
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Microsoft YaHei', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
        .container { max-width: 1400px; margin: 0 auto; background: white; border-radius: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); overflow: hidden; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; position: relative; }
        .header h1 { font-size: 32px; margin-bottom: 10px; }
        .header .update-time { font-size: 14px; opacity: 0.9; }
        .manage-btn { position: absolute; top: 30px; right: 30px; background: rgba(255, 255, 255, 0.2); color: white; border: 2px solid white; border-radius: 8px; padding: 10px 20px; font-size: 14px; cursor: pointer; transition: all 0.3s ease; }
        .manage-btn:hover { background: rgba(255, 255, 255, 0.3); transform: scale(1.05); }
        .stats-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; padding: 30px; background: #f8f9fa; }
        .stat-card { background: white; border-radius: 12px; padding: 20px; text-align: center; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); transition: transform 0.3s ease, box-shadow 0.3s ease; }
        .stat-card:hover { transform: translateY(-5px); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15); }
        .stat-card .label { font-size: 13px; color: #6c757d; margin-bottom: 8px; font-weight: 500; }
        .stat-card .value { font-size: 24px; font-weight: bold; color: #667eea; }
        .table-container { padding: 0 30px 30px 30px; overflow-x: auto; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; }
        thead { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        th { padding: 15px; text-align: left; font-weight: 600; font-size: 14px; white-space: nowrap; }
        th.number { text-align: right; }
        td { padding: 12px 15px; border-bottom: 1px solid #e9ecef; font-size: 14px; }
        td.number { text-align: right; font-weight: 500; }
        td.error-row { color: #dc3545; }
        tbody tr:hover { background-color: #f8f9fa; }
        tbody tr:last-child td { border-bottom: none; }
        tfoot { background: #f8f9fa; font-weight: bold; }
        tfoot td { padding: 15px; border-top: 2px solid #667eea; border-bottom: none; }
        .key-cell { color: #495057; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .refresh-btn { position: fixed; bottom: 30px; right: 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 50px; padding: 15px 30px; font-size: 16px; cursor: pointer; box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
        .refresh-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(102, 126, 234, 0.6); }
        .refresh-btn:active { transform: translateY(0); }
        .delete-zero-btn { position: fixed; bottom: 95px; right: 30px; background: linear-gradient(135deg, #dc3545 0%, #c82333 100%); color: white; border: none; border-radius: 50px; padding: 15px 30px; font-size: 16px; cursor: pointer; box-shadow: 0 4px 15px rgba(220, 53, 69, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
        .delete-zero-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(220, 53, 69, 0.6); }
        .delete-zero-btn:active { transform: translateY(0); }
        .delete-zero-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .delete-all-btn { position: fixed; bottom: 160px; right: 30px; background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%); color: white; border: none; border-radius: 50px; padding: 15px 30px; font-size: 16px; cursor: pointer; box-shadow: 0 4px 15px rgba(255, 107, 107, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
        .delete-all-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(255, 107, 107, 0.6); }
        .delete-all-btn:active { transform: translateY(0); }
        .delete-all-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .export-keys-btn { position: fixed; bottom: 225px; right: 30px; background: linear-gradient(135deg, #28a745 0%, #20c997 100%); color: white; border: none; border-radius: 50px; padding: 15px 30px; font-size: 16px; cursor: pointer; box-shadow: 0 4px 15px rgba(40, 167, 69, 0.4); transition: all 0.3s ease; display: flex; align-items: center; gap: 8px; }
        .export-keys-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(40, 167, 69, 0.6); }
        .export-keys-btn:active { transform: translateY(0); }
        .export-keys-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .loading { text-align: center; padding: 40px; color: #6c757d; }
        .error { text-align: center; padding: 40px; color: #dc3545; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .spinner { display: inline-block; width: 20px; height: 20px; border: 3px solid rgba(255, 255, 255, 0.3); border-radius: 50%; border-top-color: white; animation: spin 1s linear infinite; }

        /* Modal styles */
        .modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.5); z-index: 1000; align-items: center; justify-content: center; }
        .modal.show { display: flex; }
        .modal-content { background: white; border-radius: 16px; width: 90%; max-width: 800px; max-height: 90vh; overflow: auto; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3); }
        .modal-header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px 30px; display: flex; justify-content: space-between; align-items: center; }
        .modal-header h2 { font-size: 24px; }
        .close-btn { background: none; border: none; color: white; font-size: 28px; cursor: pointer; line-height: 1; }
        .modal-body { padding: 30px; }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; font-weight: 600; color: #333; }
        .form-group input, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 8px; font-size: 14px; font-family: inherit; }
        .form-group textarea { min-height: 150px; font-family: 'Courier New', monospace; }
        .btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; transition: all 0.3s ease; font-weight: 600; }
        .btn-primary { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; }
        .btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
        .btn-secondary { background: #6c757d; color: white; }
        .btn-secondary:hover { background: #5a6268; }
        .btn-danger { background: #dc3545; color: white; }
        .btn-danger:hover { background: #c82333; }
        .btn-group { display: flex; gap: 10px; margin-top: 20px; }
        .keys-list { margin-top: 30px; }
        .keys-list h3 { margin-bottom: 15px; color: #333; }
        .key-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 15px; border: 1px solid #e9ecef; border-radius: 8px; margin-bottom: 10px; background: #f8f9fa; }
        .key-item-info { flex: 1; overflow: hidden; }
        .key-item-id { font-weight: 600; color: #667eea; margin-bottom: 4px; }
        .key-item-key { font-family: 'Courier New', monospace; font-size: 12px; color: #6c757d; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .tabs { display: flex; border-bottom: 2px solid #e9ecef; margin-bottom: 20px; }
        .tab { padding: 12px 24px; background: none; border: none; font-size: 16px; font-weight: 600; color: #6c757d; cursor: pointer; border-bottom: 3px solid transparent; transition: all 0.3s ease; }
        .tab.active { color: #667eea; border-bottom-color: #667eea; }
        .tab-content { display: none; }
        .tab-content.active { display: block; }
        .success-msg { background: #d4edda; color: #155724; padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #c3e6cb; }
        .error-msg { background: #f8d7da; color: #721c24; padding: 12px; border-radius: 8px; margin-bottom: 15px; border: 1px solid #f5c6cb; }
    </style>  
</head>  
<body>
    <div class="container">
        <div class="header">
            <button class="manage-btn" onclick="openManageModal()">Key 管理</button>
            <h1>API 余额监控看板</h1>
            <div class="update-time" id="updateTime">正在加载...</div>
        </div>


        <div class="stats-cards" id="statsCards"></div>


        <div class="table-container">
            <div id="tableContent">
                <div class="loading">正在加载数据...</div>
            </div>
        </div>
    </div>

    <button class="export-keys-btn" onclick="exportKeys()" id="exportKeysBtn">
        <span>📥 导出Key</span>
    </button>

    <button class="delete-all-btn" onclick="deleteAllKeys()" id="deleteAllBtn">
        <span>🗑️ 删除所有</span>
    </button>

    <button class="delete-zero-btn" onclick="deleteZeroBalanceKeys()" id="deleteZeroBtn">
        <span>🗑️ 删除无效</span>
    </button>

    <button class="refresh-btn" onclick="loadData()">
        <span class="spinner" style="display: none;" id="spinner"></span>
        <span id="btnText">刷新数据</span>
    </button>

    <div id="manageModal" class="modal">
        <div class="modal-content">
            <div class="modal-header">
                <h2>API Key 管理</h2>
                <button class="close-btn" onclick="closeManageModal()">&times;</button>
            </div>
            <div class="modal-body">
                <div id="modalMessage"></div>

                <form onsubmit="batchImportKeys(event)">
                    <div class="form-group">
                        <label>批量导入 Keys（每行一个 Key）</label>
                        <textarea id="batchKeysInput" placeholder="例如:&#10;fk-xxxxx&#10;fk-yyyyy&#10;fk-zzzzz"></textarea>
                    </div>
                    <div class="btn-group">
                        <button type="submit" class="btn btn-primary">批量导入</button>
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('batchKeysInput').value='';">清空</button>
                    </div>
                </form>
            </div>
        </div>
    </div>  
  
  
    <script>
        // Global variable to store current API data
        let currentApiData = null;

        const formatNumber = (num) => num ? new Intl.NumberFormat('en-US').format(num) : '0';
        const formatPercentage = (ratio) => ratio ? (ratio * 100).toFixed(2) + '%' : '0.00%';  
  
  
        function loadData(retryCount = 0) {  
            const spinner = document.getElementById('spinner');  
            const btnText = document.getElementById('btnText');  
                
            spinner.style.display = 'inline-block';  
            btnText.textContent = '加载中...';  
  
  
            fetch('/api/data?t=' + new Date().getTime())  
                .then(response => {  
                    // If server is still initializing (503), auto-retry after 2 seconds
                    if (response.status === 503 && retryCount < 5) {
                        console.log(\`Server initializing, retrying in 2 seconds... (attempt \${retryCount + 1}/5)\`);
                        document.getElementById('tableContent').innerHTML = \`<div class="loading">服务器正在初始化数据，请稍候... (尝试 \${retryCount + 1}/5)</div>\`;
                        setTimeout(() => loadData(retryCount + 1), 2000);
                        return null;
                    }
                    if (!response.ok) {  
                        throw new Error('无法加载数据: ' + response.statusText);  
                    }  
                    return response.json();  
                })  
                .then(data => {
                    if (data === null) return; // Skip if retrying
                    if (data.error) {  
                        throw new Error(data.error);  
                    }  
                    displayData(data);  
                })  
                .catch(error => {  
                    document.getElementById('tableContent').innerHTML = \`<div class="error">❌ 加载失败: \${error.message}</div>\`;  
                    document.getElementById('updateTime').textContent = "加载失败";  
                })  
                .finally(() => {  
                    spinner.style.display = 'none';  
                    btnText.textContent = '🔄 刷新数据';  
                });  
        }  
  
  
        function displayData(data) {
            // Store data globally for other functions to use
            currentApiData = data;

            document.getElementById('updateTime').textContent = \`最后更新: \${data.update_time} | 共 \${data.total_count} 个API Key\`;

            const totalAllowance = data.totals.total_totalAllowance;
            const totalUsed = data.totals.total_orgTotalTokensUsed;
            // MODIFICATION: Use the totalRemaining value calculated on the backend.
            const totalRemaining = data.totals.totalRemaining;
            const overallRatio = totalAllowance > 0 ? totalUsed / totalAllowance : 0;  
  
  
            const statsCards = document.getElementById('statsCards');  
            statsCards.innerHTML = \`  
                <div class="stat-card"><div class="label">总计额度 (Total Allowance)</div><div class="value">\${formatNumber(totalAllowance)}</div></div>  
                <div class="stat-card"><div class="label">已使用 (Total Used)</div><div class="value">\${formatNumber(totalUsed)}</div></div>  
                <div class="stat-card"><div class="label">剩余额度 (Remaining)</div><div class="value">\${formatNumber(totalRemaining)}</div></div>  
                <div class="stat-card"><div class="label">使用百分比 (Usage %)</div><div class="value">\${formatPercentage(overallRatio)}</div></div>  
            \`;  
  
  
            let tableHTML = \`
                <table>
                    <thead>
                        <tr>
                            <th>API Key</th>
                            <th>开始时间</th>
                            <th>结束时间</th>
                            <th class="number">总计额度</th>
                            <th class="number">已使用</th>
                            <th class="number">剩余额度</th>
                            <th class="number">使用百分比</th>
                            <th style="text-align: center;">操作</th>
                        </tr>
                    </thead>
                    <tbody>\`;


            data.data.forEach(item => {
                if (item.error) {
                    tableHTML += \`
                        <tr>
                            <td class="key-cell" title="\${item.key}">\${item.key}</td>
                            <td colspan="5" class="error-row">加载失败: \${item.error}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-primary" onclick="refreshSingleKey('\${item.id}')" style="padding: 6px 12px; font-size: 12px; margin-right: 5px;">刷新</button>
                                <button class="btn btn-danger" onclick="deleteKeyFromTable('\${item.id}')" style="padding: 6px 12px; font-size: 12px;">删除</button>
                            </td>
                        </tr>\`;
                } else {
                    // MODIFICATION: Calculate remaining here, ensuring it's not negative.
                    const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                    tableHTML += \`
                        <tr id="key-row-\${item.id}">
                            <td class="key-cell" title="\${item.key}">\${item.key}</td>
                            <td>\${item.startDate}</td>
                            <td>\${item.endDate}</td>
                            <td class="number">\${formatNumber(item.totalAllowance)}</td>
                            <td class="number">\${formatNumber(item.orgTotalTokensUsed)}</td>
                            <td class="number">\${formatNumber(remaining)}</td>
                            <td class="number">\${formatPercentage(item.usedRatio)}</td>
                            <td style="text-align: center;">
                                <button class="btn btn-primary" onclick="refreshSingleKey('\${item.id}')" style="padding: 6px 12px; font-size: 12px; margin-right: 5px;">刷新</button>
                                <button class="btn btn-danger" onclick="deleteKeyFromTable('\${item.id}')" style="padding: 6px 12px; font-size: 12px;">删除</button>
                            </td>
                        </tr>\`;
                }
            });


            tableHTML += \`
                    </tbody>
                </table>\`; 
  
  
            document.getElementById('tableContent').innerHTML = tableHTML;  
        }  
  
  
        document.addEventListener('DOMContentLoaded', loadData);

        // Modal and Key Management Functions
        function openManageModal() {
            document.getElementById('manageModal').classList.add('show');
            clearMessage();
        }

        function closeManageModal() {
            document.getElementById('manageModal').classList.remove('show');
            clearMessage();
        }

        function showMessage(message, isError = false) {
            const msgDiv = document.getElementById('modalMessage');
            msgDiv.innerHTML = \`<div class="\${isError ? 'error-msg' : 'success-msg'}">\${message}</div>\`;
            setTimeout(() => clearMessage(), 5000);
        }

        function clearMessage() {
            document.getElementById('modalMessage').innerHTML = '';
        }

        async function exportKeys() {
            const password = prompt('请输入导出密码：');
            if (!password) return;

            const exportBtn = document.getElementById('exportKeysBtn');
            exportBtn.disabled = true;
            exportBtn.innerHTML = '<span>⏳ 导出中...</span>';

            try {
                const response = await fetch('/api/keys/export', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });

                const result = await response.json();

                if (response.ok) {
                    const keysText = result.keys.map(k => k.key).join('\\n');
                    const blob = new Blob([keysText], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = Object.assign(document.createElement('a'), {
                        href: url,
                        download: \`api_keys_export_\${new Date().toISOString().split('T')[0]}.txt\`
                    });
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    alert(\`成功导出 \${result.keys.length} 个Key\`);
                } else {
                    alert('导出失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            } finally {
                exportBtn.disabled = false;
                exportBtn.innerHTML = '<span>📥 导出Key</span>';
            }
        }

        async function deleteAllKeys() {
            if (!currentApiData) return alert('请先加载数据');

            const totalKeys = currentApiData.total_count;
            if (totalKeys === 0) return alert('没有可删除的Key');

            const confirmMsg = \`⚠️ 危险操作！\\n\\n确定要删除所有 \${totalKeys} 个Key吗？\\n此操作不可恢复！\`;
            if (!confirm(confirmMsg)) return;

            const secondConfirm = prompt('请输入 "确认删除" 以继续：');
            if (secondConfirm !== '确认删除') return alert('操作已取消');

            const deleteBtn = document.getElementById('deleteAllBtn');
            deleteBtn.disabled = true;
            deleteBtn.innerHTML = '<span>⏳ 删除中...</span>';

            try {
                const allIds = currentApiData.data.map(item => item.id);
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: allIds })
                });

                const result = await response.json();

                if (response.ok) {
                    alert(\`成功删除 \${result.deleted || totalKeys} 个Key\`);
                    loadData(); // Refresh data
                } else {
                    alert('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = '<span>🗑️ 删除所有</span>';
            }
        }

        async function deleteZeroBalanceKeys() {
            if (!currentApiData) return alert('请先加载数据');

            const zeroBalanceKeys = currentApiData.data.filter(item => {
                if (item.error) return false;
                const remaining = Math.max(0, (item.totalAllowance || 0) - (item.orgTotalTokensUsed || 0));
                return remaining === 0;
            });

            if (zeroBalanceKeys.length === 0) return alert('没有找到余额为0的Key');

            const confirmMsg = \`确定要删除 \${zeroBalanceKeys.length} 个余额为0的Key吗？\\n\\n将删除以下Key ID:\\n\${zeroBalanceKeys.map(k => k.id).join('\\n')}\`;

            if (!confirm(confirmMsg)) {
                return;
            }

            const deleteBtn = document.getElementById('deleteZeroBtn');
            deleteBtn.disabled = true;
            deleteBtn.innerHTML = '<span>⏳ 删除中...</span>';

            try {
                const response = await fetch('/api/keys/batch-delete', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ids: zeroBalanceKeys.map(k => k.id) })
                });

                const result = await response.json();

                if (response.ok) {
                    alert(\`成功删除 \${result.deleted || zeroBalanceKeys.length} 个Key\`);
                    loadData(); // Refresh data
                } else {
                    alert('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            } finally {
                deleteBtn.disabled = false;
                deleteBtn.innerHTML = '<span>🗑️ 删除无效</span>';
            }
        }

        async function batchImportKeys(event) {
            event.preventDefault();
            const input = document.getElementById('batchKeysInput').value.trim();

            if (!input) return showMessage('请输入要导入的 Keys', true);

            const lines = input.split('\\n').map(line => line.trim()).filter(line => line.length > 0);
            const keysToImport = [];
            const timestamp = Date.now();
            let autoIdCounter = 1;

            for (const line of lines) {
                if (line.includes(':')) {
                    const [id, key] = line.split(':').map(s => s.trim());
                    if (id && key) keysToImport.push({ id, key });
                } else {
                    const randomSuffix = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
                    keysToImport.push({
                        id: \`key-\${timestamp}-\${autoIdCounter++}-\${randomSuffix}\`,
                        key: line
                    });
                }
            }

            if (keysToImport.length === 0) return showMessage('没有有效的 Key 可以导入', true);

            try {
                const response = await fetch('/api/keys', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(keysToImport)
                });

                const result = await response.json();

                if (response.ok) {
                    const msg = \`成功导入 \${result.added} 个 Key\${result.skipped > 0 ? \`, 跳过 \${result.skipped} 个重复的 Key\` : ''}\`;
                    showMessage(msg);
                    document.getElementById('batchKeysInput').value = '';
                    loadData(); // Refresh main data
                } else {
                    showMessage(result.error || '批量导入失败', true);
                }
            } catch (error) {
                showMessage('网络错误: ' + error.message, true);
            }
        }

        async function deleteKeyFromTable(id) {
            if (!confirm(\`确定要删除 Key "\${id}" 吗？\`)) return;

            try {
                const response = await fetch(\`/api/keys/\${id}\`, { method: 'DELETE' });
                const result = await response.json();

                if (response.ok) {
                    alert(\`Key "\${id}" 已删除成功\`);
                    loadData();
                } else {
                    alert('删除失败: ' + (result.error || '未知错误'));
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
            }
        }

        async function refreshSingleKey(id) {
            const row = document.getElementById(\`key-row-\${id}\`);
            if (!row) return alert('找不到对应的行');

            const cells = row.querySelectorAll('td');
            const originalContent = [];
            cells.forEach((cell, index) => {
                originalContent[index] = cell.innerHTML;
                if (index > 0 && index < cells.length - 1) {
                    cell.innerHTML = '<span style="color: #6c757d;">⏳ 刷新中...</span>';
                }
            });

            try {
                const response = await fetch(\`/api/keys/\${id}/refresh\`, {
                    method: 'POST'
                });

                const result = await response.json();

                if (response.ok && result.data) {
                    const item = result.data;
                    
                    if (item.error) {
                        cells[1].innerHTML = '<span class="error-row">加载失败: ' + item.error + '</span>';
                        cells[2].colSpan = 5;
                        for (let i = 3; i < cells.length - 1; i++) cells[i].style.display = 'none';
                    } else {
                        const remaining = Math.max(0, item.totalAllowance - item.orgTotalTokensUsed);
                        [cells[1].innerHTML, cells[2].innerHTML, cells[3].innerHTML, 
                         cells[4].innerHTML, cells[5].innerHTML, cells[6].innerHTML] = 
                        [item.startDate, item.endDate, formatNumber(item.totalAllowance),
                         formatNumber(item.orgTotalTokensUsed), formatNumber(remaining), formatPercentage(item.usedRatio)];
                        
                        for (let i = 1; i < cells.length - 1; i++) {
                            cells[i].style.display = '';
                            cells[i].colSpan = 1;
                        }
                    }
                    loadData();
                } else {
                    alert('刷新失败: ' + (result.error || '未知错误'));
                    cells.forEach((cell, index) => cell.innerHTML = originalContent[index]);
                }
            } catch (error) {
                alert('网络错误: ' + error.message);
                cells.forEach((cell, index) => cell.innerHTML = originalContent[index]);
            }
        }

        document.addEventListener('click', (event) => {
            const modal = document.getElementById('manageModal');
            if (event.target === modal) closeManageModal();
        });
    </script>
</body>
</html>
`;  
  
  
// ==================== API Data Fetching ====================

/**
 * Batch process promises with concurrency control to avoid rate limiting.
 */
async function batchProcess<T, R>(
  items: T[],
  processor: (item: T) => Promise<R>,
  concurrency: number = 10,
  delayMs: number = 100
): Promise<R[]> {
  const results: R[] = [];
  
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
    
    // Add delay between batches to avoid rate limiting
    if (i + concurrency < items.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}

/**
 * Fetches usage data for a single API key with retry logic.
 */
async function fetchApiKeyData(id: string, key: string, retryCount = 0): Promise<ApiKeyResult> {
  const maskedKey = maskApiKey(key);
  const maxRetries = 2;

  try {
    const response = await fetch(CONFIG.API_ENDPOINT, {
      headers: {
        'Authorization': `Bearer ${key}`,
        'User-Agent': CONFIG.USER_AGENT,
      }
    });

    if (!response.ok) {
      if (response.status === 401 && retryCount < maxRetries) {
        const delayMs = (retryCount + 1) * 1000;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return fetchApiKeyData(id, key, retryCount + 1);
      }
      return { id, key: maskedKey, error: `HTTP ${response.status}` };
    }

    const apiData: ApiResponse = await response.json();
    const { usage } = apiData;
    
    if (!usage?.standard) {
      return { id, key: maskedKey, error: 'Invalid API response' };
    }

    const { standard } = usage;
    return {
      id,
      key: maskedKey,
      startDate: formatDate(usage.startDate),
      endDate: formatDate(usage.endDate),
      orgTotalTokensUsed: standard.orgTotalTokensUsed || 0,
      totalAllowance: standard.totalAllowance || 0,
      usedRatio: standard.usedRatio || 0,
    };
  } catch (error) {
    return { id, key: maskedKey, error: 'Failed to fetch' };
  }
}  
  
  
// ==================== Type Guards ====================

const isApiUsageData = (result: ApiKeyResult): result is ApiUsageData => !('error' in result);

// ==================== Data Aggregation ====================

/**
 * Aggregates data from all configured API keys.
 */
async function getAggregatedData(): Promise<AggregatedResponse> {
  const keyPairs = await getAllKeys();
  const beijingTime = getBeijingTime();
  const emptyResponse = {
    update_time: format(beijingTime, "yyyy-MM-dd HH:mm:ss"),
    total_count: 0,
    totals: { total_orgTotalTokensUsed: 0, total_totalAllowance: 0, totalRemaining: 0 },
    data: [],
  };

  if (keyPairs.length === 0) return emptyResponse;

  const results = await batchProcess(
    keyPairs,
    ({ id, key }) => fetchApiKeyData(id, key),
    10,
    100
  );

  const validResults = results.filter(isApiUsageData);
  const sortedValid = validResults
    .map(r => ({ ...r, remaining: Math.max(0, r.totalAllowance - r.orgTotalTokensUsed) }))
    .sort((a, b) => b.remaining - a.remaining)
    .map(({ remaining, ...rest }) => rest);

  const totals = validResults.reduce((acc, res) => ({
    total_orgTotalTokensUsed: acc.total_orgTotalTokensUsed + res.orgTotalTokensUsed,
    total_totalAllowance: acc.total_totalAllowance + res.totalAllowance,
    totalRemaining: acc.totalRemaining + Math.max(0, res.totalAllowance - res.orgTotalTokensUsed)
  }), emptyResponse.totals);

  logKeysWithBalance(validResults, keyPairs);

  return {
    update_time: format(beijingTime, "yyyy-MM-dd HH:mm:ss"),
    total_count: keyPairs.length,
    totals,
    data: [...sortedValid, ...results.filter(r => 'error' in r)],
  };
}

/**
 * Logs API keys that still have remaining balance.
 */
function logKeysWithBalance(validResults: ApiUsageData[], keyPairs: ApiKey[]): void {
  const keysWithBalance = validResults.filter(r => {
    const remaining = r.totalAllowance - r.orgTotalTokensUsed;
    return remaining > 0;
  });

  if (keysWithBalance.length > 0) {
    console.log("=".repeat(80));
    console.log("📋 剩余额度大于0的API Keys:");
    console.log("-".repeat(80));

    keysWithBalance.forEach(item => {
      const originalKeyPair = keyPairs.find(kp => kp.id === item.id);
      if (originalKeyPair) {
        console.log(originalKeyPair.key);
      }
    });

    console.log("=".repeat(80) + "\n");
  } else {
    console.log("\n⚠️  没有剩余额度大于0的API Keys\n");
  }
}  


// ==================== Auto-Refresh Logic (NEW) ====================

/**
 * Periodically fetches data and updates the server state cache.
 */
async function autoRefreshData() {
  if (serverState.isCurrentlyUpdating()) return;
  
  const timestamp = format(getBeijingTime(), "HH:mm:ss");
  console.log(`[${timestamp}] Starting data refresh...`);
  serverState.startUpdate();
  
  try {
    const data = await getAggregatedData();
    serverState.updateCache(data);
    console.log(`[${timestamp}] Data updated successfully.`);
  } catch (error) {
    serverState.setError(error instanceof Error ? error.message : 'Refresh failed');
  }
}

  
  
// ==================== Route Handlers ====================

/**
 * Handles the root path - serves the HTML dashboard.
 */
function handleRoot(): Response {
  return new Response(HTML_CONTENT, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

/**
 * Handles the /api/data endpoint - returns cached aggregated usage data.
 */
async function handleGetData(): Promise<Response> {
  const cachedData = serverState.getData();
  
  if (cachedData) {
    return createJsonResponse(cachedData);
  }
  
  const lastError = serverState.getError();
  if (lastError) {
    return createErrorResponse(lastError, 500);
  }

  // If there's no data and no error, it means an update is in progress
  if (serverState.isCurrentlyUpdating()) {
    return createErrorResponse("数据正在更新中，请稍候...", 503);
  }

  // This shouldn't happen normally after initial load, but just in case
  return createErrorResponse("暂无数据，请稍后刷新。", 503);
}

/**
 * Handles GET /api/keys - returns all stored API keys.
 */
async function handleGetKeys(): Promise<Response> {
  try {
    const keys = await getAllKeys();
    return createJsonResponse(keys);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error getting keys:', errorMessage);
    return createErrorResponse(errorMessage, 500);
  }
}

/**
 * Handles POST /api/keys - adds single or multiple API keys.
 */
async function handleAddKeys(req: Request): Promise<Response> {
  try {
    const body = await req.json();

    // Support batch import
    if (Array.isArray(body)) {
      return await handleBatchImport(body);
    } else {
      return await handleSingleKeyAdd(body);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    console.error('Error adding keys:', errorMessage);
    return createErrorResponse(errorMessage, 400);
  }
}

async function handleBatchImport(items: unknown[]): Promise<Response> {
  let added = 0, skipped = 0;
  const existingKeys = new Set((await getAllKeys()).map(k => k.key));

  for (const item of items) {
    if (!item || typeof item !== 'object' || !('key' in item)) continue;
    
    const { key } = item as { key: string };
    if (!key || existingKeys.has(key)) {
      if (key) skipped++;
      continue;
    }

    const id = `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    await addKey(id, key);
    existingKeys.add(key);
    added++;
  }

  if (added > 0) autoRefreshData();

  return createJsonResponse({ success: true, added, skipped });
}

async function handleSingleKeyAdd(body: unknown): Promise<Response> {
  if (!body || typeof body !== 'object' || !('key' in body)) {
    return createErrorResponse("key is required", 400);
  }

  const { key } = body as { key: string };
  if (!key) return createErrorResponse("key cannot be empty", 400);
  if (await apiKeyExists(key)) return createErrorResponse("API key already exists", 409);

  const id = `key-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  await addKey(id, key);
  autoRefreshData();
  
  return createJsonResponse({ success: true });
}

async function handleDeleteKey(pathname: string): Promise<Response> {
  const id = pathname.split("/api/keys/")[1];
  if (!id) return createErrorResponse("Key ID is required", 400);

  await deleteKey(id);
  autoRefreshData();
  
  return createJsonResponse({ success: true });
}

async function handleBatchDeleteKeys(req: Request): Promise<Response> {
  try {
    const { ids } = await req.json() as { ids: string[] };
    if (!Array.isArray(ids) || ids.length === 0) {
      return createErrorResponse("ids array is required", 400);
    }

    await Promise.all(ids.map(id => deleteKey(id).catch(() => {})));
    autoRefreshData();

    return createJsonResponse({ success: true, deleted: ids.length });
  } catch (error) {
    return createErrorResponse(error instanceof Error ? error.message : 'Invalid JSON', 400);
  }
}

/**
 * Handles POST /api/keys/export - exports all API keys with password verification.
 */
async function handleExportKeys(req: Request): Promise<Response> {
  try {
    const { password } = await req.json() as { password: string };

    // Verify password
    if (password !== CONFIG.EXPORT_PASSWORD) {
      return createErrorResponse("密码错误", 401);
    }

    // Get all keys (unmasked)
    const keys = await getAllKeys();

    return createJsonResponse({
      success: true,
      keys
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Invalid JSON';
    console.error('Error exporting keys:', errorMessage);
    return createErrorResponse(errorMessage, 400);
  }
}

/**
 * Handles POST /api/keys/:id/refresh - refreshes data for a single API key.
 */
async function handleRefreshSingleKey(pathname: string): Promise<Response> {
  try {
    const id = pathname.split("/api/keys/")[1].replace("/refresh", "");

    if (!id) {
      return createErrorResponse("Key ID is required", 400);
    }

    // Get the key from database
    const result = await kv.get<string>(["api_keys", id]);
    
    if (!result.value) {
      return createErrorResponse("Key not found", 404);
    }

    const key = result.value;

    // Fetch fresh data for this key
    const keyData = await fetchApiKeyData(id, key);

    return createJsonResponse({
      success: true,
      data: keyData
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error refreshing key:', errorMessage);
    return createErrorResponse(errorMessage, 500);
  }
}

// ==================== Main Request Handler ====================

/**
 * Main HTTP request handler that routes requests to appropriate handlers.
 */
async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Route: Root path - Dashboard
  if (url.pathname === "/") {
    return handleRoot();
  }

  // Route: GET /api/data - Get aggregated usage data
  if (url.pathname === "/api/data" && req.method === "GET") {
    return await handleGetData();
  }

  // Route: GET /api/keys - Get all keys
  if (url.pathname === "/api/keys" && req.method === "GET") {
    return await handleGetKeys();
  }

  // Route: POST /api/keys - Add key(s)
  if (url.pathname === "/api/keys" && req.method === "POST") {
    return await handleAddKeys(req);
  }

  // Route: POST /api/keys/batch-delete - Batch delete keys
  if (url.pathname === "/api/keys/batch-delete" && req.method === "POST") {
    return await handleBatchDeleteKeys(req);
  }

  // Route: POST /api/keys/export - Export keys with password
  if (url.pathname === "/api/keys/export" && req.method === "POST") {
    return await handleExportKeys(req);
  }

  // Route: DELETE /api/keys/:id - Delete a key
  if (url.pathname.startsWith("/api/keys/") && req.method === "DELETE") {
    return await handleDeleteKey(url.pathname);
  }

  // Route: POST /api/keys/:id/refresh - Refresh single key
  if (url.pathname.match(/^\/api\/keys\/.+\/refresh$/) && req.method === "POST") {
    return await handleRefreshSingleKey(url.pathname);
  }

  // 404 for all other routes
  return new Response("Not Found", { status: 404 });
}

// ==================== Server Initialization ====================

async function startServer() {
  console.log("Initializing server...");
  
  // Perform an initial data fetch on startup and WAIT for it to complete
  console.log("Performing initial data fetch...");
  await autoRefreshData();
  console.log("Initial data loaded successfully.");
  
  // Set up the interval for subsequent refreshes
  setInterval(autoRefreshData, CONFIG.AUTO_REFRESH_INTERVAL_SECONDS * 1000);
  
  console.log(`Server running on http://localhost:${CONFIG.PORT}`);
  serve(handler, { port: CONFIG.PORT });
}

startServer();
