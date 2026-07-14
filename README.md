# NewsTune Agent Skill

讓 Claude Code / Codex 直接操作 [NewsTune](https://podcast.newstune.app)——把你的想法、資料源與工程日誌變成持續更新的 podcast 節目。

## 這是什麼

這是一個 AI agent skill：安裝後，你的 coding agent 就能透過 NewsTune 公開 Agent API 完成三大支柱的工作：

- **聲音與主持人（複製聲音）**——透過瀏覽器 handoff 複製你自己的聲音（麥克風與同意流程留在網頁端）、搜尋與領養社群聲音、試聽任何聲音，並在其上建立有獨立人設的主持人。
- **系列內容創作**——建立私人或公開 podcast 系列，從 agent 提供的素材（`material_to_podcast`）或本地撰寫的腳本（`script_to_audio`）生成集數、渲染獨立 TTS，需要時再開啟 RSS 發佈；完成後直接回傳該集的收聽連結，NewsTune 也會寄送新集數通知信。
- **專案追蹤與排程**——安裝背景 hook 自動記錄重要的開發 session（決策、轉向、里程碑——記「為什麼」而不只是「做了什麼」），再把日誌手動或按週排程轉成 podcast 集數。

## 安裝方式

### 方法一：貼 prompt 給你的 AI agent（推薦）

把下面這段貼給 Claude Code 或 Codex，它會自動完成安裝並開始 onboarding：

```text
請幫我安裝 NewsTune Agent Skill（安裝後你就能直接操作 NewsTune：複製聲音、建立 podcast 系列、自動記錄專案進度並排程生成節目）。

步驟：
1. 依你的環境選擇 skills 目錄：
   - Claude Code：~/.claude/skills/newstune-agent-api
   - Codex：~/.codex/skills/newstune-agent-api（或 ~/.agents/skills/newstune-agent-api）
2. 執行 git clone https://github.com/yuniverses/newstune-agent-skill 到該目錄（必要時先建立上層資料夾；若目錄已存在，先停下來告訴我，不要覆蓋）。
3. 安裝完成後，呼叫 newstune-agent-api skill 開始首次引導：請它介紹功能，並協助我建立 NewsTune API key、完成基本設定。
```

> 這段 prompt 是 canonical 版本——NewsTune 網頁前端「Agent Skills」彈窗內的安裝 prompt 與此逐字同步；改其中一邊時務必同步另一邊。

### 方法二：手動 git clone

```bash
# Claude Code
git clone https://github.com/yuniverses/newstune-agent-skill ~/.claude/skills/newstune-agent-api

# Codex
git clone https://github.com/yuniverses/newstune-agent-skill ~/.codex/skills/newstune-agent-api
```

裝好後，在對話中提到 NewsTune（例如「幫我把這個專案做成每週 podcast」），agent 就會自動載入這個 skill。

## 需求

- Node.js 18+（scripts 為零依賴 Node ESM，不需 `npm install`）
- Claude Code 或 Codex CLI
- NewsTune 帳號與 API key——在 <https://podcast.newstune.app/beta/#api-keys> 登入後建立，複製一次性 secret 交給 agent

## 安全性說明

- API key 只存在本機 `.private/credentials.json`，檔案權限 0600。
- `.private/` 已列入 `.gitignore`，永遠不會進 git，也不會出現在這個 repo。
- Scripts 不會在 log、輸出或生成檔案中印出原始 API key（只顯示遮罩後的形式）。

## 快速開始

```bash
# 1. 存入你的 API key（一次性 secret 來自網頁的建立彈窗）
node scripts/credentials.mjs set --key 'nt_live_...'

# 2. 驗證連線、scopes 與額度
node scripts/smoke_test.mjs
```

之後的一切——需求訪談、選主持人、建系列、生成集數、排程——都交給 agent 依 `SKILL.md` 的流程進行。

---

## English

**NewsTune Agent Skill** lets Claude Code / Codex operate [NewsTune](https://podcast.newstune.app) directly through its public Agent API, built around three pillars: **voices & hosts** (clone your own voice via browser handoff, adopt community voices, build hosts with personas), **series content creation** (create podcast series, generate episodes from agent material or local scripts, standalone TTS, optional RSS publishing), and **project tracking & scheduling** (background hooks that journal significant coding sessions, then turn the journal into episodes manually or on a weekly schedule).

**Install**: paste the prompt block above to your agent, or clone manually into your harness's skills directory (`~/.claude/skills/newstune-agent-api` for Claude Code, `~/.codex/skills/newstune-agent-api` for Codex).

**Requirements**: Node.js 18+, Claude Code or Codex CLI, and a NewsTune account with an API key created at <https://podcast.newstune.app/beta/#api-keys>.

**Security**: your API key lives only in the local `.private/credentials.json` (0600, git-ignored) and is never printed or committed.
