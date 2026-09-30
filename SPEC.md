# 话术透镜（huashu-lens）· 规格文档 v1

> **后记（改名）**：本项目已定名 **spinlens · 话术照妖镜**。本文档写于定名之前，正文保留当时的占位名 `huashu-lens` / 「话术透镜」，不改写历史。

> 工作名占位：`huashu-lens`（正式名待定，见 §15-O1）
> 状态：**待主人审阅**。审阅通过前不写任何产品代码。
> 路径：仓库根目录下的 `SPEC.md`

---

## 1. 目标与非目标

### 1.1 目标
让任何一个人（哪怕不懂编程）能**输入一个 B 站视频链接，得到一份"这条视频里有多少条评论在使用话术、分别是哪几类、原文是哪条"的可核对报告**。

定位是**抛砖引玉**：不是成熟产品，是把"话术可以被结构化识别"这个思路做成可运行、可复现、可扩展的最小闭环，供社区接手。

### 1.2 非目标（v1 明确不做）
- ❌ 不做打包 exe（体积大、易被杀软误报、最劝退）
- ❌ 不做图形界面 / 网页版（CORS 会让"本地 HTML 直连 API"走不通）
- ❌ 不做楼中楼（子评论）抓取 —— v1 只抓主评论
- ❌ 不做立场判定（不判断说话人属于哪一派）
- ❌ 不引入本地语义模型（onnx 等）作为默认路径
- ❌ 不输出"谁对谁错"的任何结论

### 1.3 中立性约束（硬性）
1. 工具**同时识别所有阵营的话术**，规则本身不带立场。
2. 输出只回答「**哪条评论命中了哪条规则**」，不回答「谁在使坏」。
3. 每次输出必须包含免责声明（见 §11.3）。
4. 工具不得内置任何"针对真实个人的挂人/围攻"辅助功能。

---

## 2. 实测基线（本机真跑，非推测）

所有数字来自 2026-09-29 在主人机器上的实测（Windows / Node / Chrome 154，**零 Cookie**）。

| 编号 | 结论 | 证据 |
|---|---|---|
| B1 | 免登录可抓取 | `nav` 返回 `code=-101 isLogin=false`，评论接口仍返回 `code=0` |
| B2 | **必须用 WBI 签名端点** | `/x/v2/reply/wbi/main` 可用；旧端点 `/x/v2/reply` 与 `/x/v2/reply/main` 游客只给 **3 条** |
| B3 | **主评论可拿全** | 视频1：主评论 1802 + Σrcount 5015 = 6817 ≈ all_count 6826（缺 9，99.5%）<br>视频2：58 + 45 = 103 ≈ 104（98.3%） |
| B4 | `all_count` 含楼中楼 | 同上 —— 它是**总数**，不能当主评论分母 |
| B5 | 单页容量上限 30 | `ps=20→20`、`ps=30→30`、`ps=49→30`、`ps=50→30` |
| B6 | 深翻不触发限流 | 61 页 / 1802 条 / 18 秒 / **0 错误** |
| B7 | **带半套 cookie 更糟** | 仅带 `buvid3+buvid4` 时被风控砍到 **3 条** ⇒ 默认**不带任何 cookie** |
| B8 | 纯 Node 可跑 | 仅用 `node:crypto`(MD5) + 全局 `fetch`，零第三方依赖 |

### 2.1 由此确定的三条设计红线
1. **默认不带 cookie**（B7）；`--cookie` 只作为用户显式选择的兜底开关。
2. **报告必须同时显示"主评论数"与"all_count(含楼中楼)"**（B4），否则用户会以为抓漏了。
3. **签名逻辑集中在一个模块内**（B2 的 WBI 是最大单点风险）。

---

## 3. 使用场景

| # | 场景 | 命令 |
|---|---|---|
| S1 | 路人：看一个视频的评论风气 | `node huashu.js https://www.bilibili.com/video/BVxxxx/` |
| S2 | 分析者：只要"和稀泥 + 假中立" | `node huashu.js BVxxxx --types T1,T2 --out a.csv` |
| S3 | 视频作者：批量跑多个视频 | `node huashu.js BV1 BV2 BV3 --quiet` |
| S4 | 扩展者：自定义话术类型 | `node huashu.js BVxxxx --rules my-rules.json` |
| S5 | 有 AI 的人：让模型复核命中的候选 | `node huashu.js BVxxxx --ai ollama:qwen2.5` |
| S6 | 撞限流的人：手动带 cookie | `node huashu.js BVxxxx --cookie "SESSDATA=..."` |

---

## 4. 系统结构

### 4.1 模块清单（深模块）

| 模块 | 接口（调用方需要知道的最小面） | 隐藏的复杂度 |
|---|---|---|
| **Fetcher** | `fetchAll(target, opts) → Comment[]` | WBI 签名、游标翻页、节流、退避重试、终止判定 |
| **RuleSet** | `load(path?) → RuleSet` | 文件解析、schema 校验、默认值填充、版本兼容 |
| **Detector** | `detect(comments, ruleSet) → Hit[]` | L1/L2/L3 三层匹配、打分、证据剪辑、语境排除 |
| **Reporter** | `report(result, format) → string` | 终端排版、百分比、CSV 转义、免责声明 |
| **CLI** | `main(argv)` | 参数解析、错误提示、退出码 |

**深度检验（删除测试）**：
- 删掉 **Fetcher** → WBI 签名 + 翻页 + 退避 会散落到 CLI 里，复杂度**重现**。✅ 保留。
- 删掉 **Detector** → 三层匹配逻辑会散到 Reporter 和 CLI。✅ 保留。
- 删掉 **Reporter** → 终端排版会散进 CLI，但只有一处调用……⚠️ **边界待审**（见 §15-O4）。

### 4.2 依赖方向（严格单向）

```
CLI ──> Fetcher ──> (网络)
 │        │
 │        └──> Comment[]
 ├──> RuleSet ──> RuleSpec
 ├──> Detector(Comment[], RuleSpec) ──> Hit[]
 └──> Reporter(Hit[], meta) ──> string
```

**约束**：Detector **不知道**数据来自 B 站，也**不知道**怎么打印；Fetcher **不知道**什么是话术。二者通过 `Comment[]` 这一纯数据结构解耦。

### 4.3 哪些 seam 是真的（两个 adapter 原则）

| Seam | Adapter A | Adapter B | 判定 |
|---|---|---|---|
| **平台采集** | `bilibili`（v1 实现） | `xiaohongshu`（v1 只留骨架） | ✅ 真 seam |
| **AI 精排** | `none`（默认，规则直出） | `openai-compatible` / `ollama` | ✅ 真 seam |
| **报告输出** | `terminal` | `csv` | ✅ 真 seam |
| 语义识别后端 | 规则 | 模型 | ⚠️ 归入 AI 精排 seam，不新开 |

**明确不引入的 seam**（防止过度设计）：不做插件注册表、不做事件总线、不做 DI 容器、不做配置文件分层。

---

## 5. 数据模型

```
Comment
  rpid      string   评论唯一 id
  user      string   用户名
  uid       string   用户 uid（可为空）
  like      number   点赞数
  ctime     number   Unix 时间戳（秒）
  isPinned  boolean  是否置顶
  msg       string   正文（已做换行归一）
  rcount    number   该主评论下的楼中楼数（v1 不抓，仅作报告参考）

Hit
  rpid      string
  types     { id, score, evidence[] }[]   可多类命中
  maxScore  number
  guarded   boolean   是否被语境规则降权
  guardNote string    降权原因（如 "quote" / "negation"）

ReportMeta
  target, title, aid, bvid
  mainCount      抓到的主评论数
  allCount       all_count（含楼中楼）
  rcountSum      Σ楼中楼
  elapsedMs, errorCount, ruleVersion, threshold
```

---

## 6. 规则文件格式（v1）

外置 JSON，**这是"自定义话术"的落点**。不提供 `--rules` 时使用内置默认。

```json
{
  "version": 1,
  "name": "default",
  "threshold": 0.6,
  "lexiconWeight": 0.25,
  "lexiconCap": 2,
  "contextGuards": {
    "quoteChars": ["「」", "“”", "‘’", "''", "《》"],
    "negationBefore": ["别被", "谨记", "常识", "所谓", "不就是", "经典", "警惕", "识别"],
    "negationWindow": 12,
    "penalty": 0.7
  },
  "types": [
    {
      "id": "T1",
      "name": "和稀泥型",
      "note": "都别吵了，两边都有问题",
      "examples": ["都别吵了，两边都有问题"],
      "lexicon": ["和稀泥", "各打五十大板", "理中客", "两边都有问题", "各退一步", "都有道理", "看戏"],
      "patterns": [
        { "re": "(两边|双方|大家).{0,8}(都|各).{0,8}(有问题|有错|不对|五十大板)", "score": 0.8 },
        { "re": "都别(吵|争|骂|打)了", "score": 0.9 }
      ],
      "exclude": ["(别|不要)被.{0,6}(话术|带节奏)"]
    }
  ]
}
```

### 6.1 兼容性规则
- `version` 缺失或 ≠ 1 → 报错退出，提示升级脚本。
- 未知字段**忽略**（不报错），缺失字段用默认值。
- `patterns[].re` 用 JS 正则，**编译失败该条跳过并警告**，不整体崩溃。
- **内置规则分两包**（让工具可复用，而非只服务本次事件）：
  - `common`：通用话术 —— 和稀泥 / 假中立 / 消解 / 扣帽 / 信息茧房 / 反饭圈
  - `event-deepseek`：事件专属 —— 奶鲸 / 奶龙 等具体梗
  - 默认加载 `common`；`--pack event-deepseek` 或全加载。

---

## 7. 检测算法

### 7.1 三层
| 层 | 作用 | 谁负责 |
|---|---|---|
| L1 词表 | **召回**（提高查全） | `lexicon` 命中数 × `lexiconWeight`，上限 `lexiconCap` 个 |
| L2 句式模板 | **准度**（提高查准） | `patterns` 直接给分 |
| L3 语境排除 | **区分使用者 vs 识破者** | 引号包裹 / 命中词前 N 字内有否定或元话语标记 |

### 7.2 打分公式
```
raw(t, c) = Σ(命中的 pattern.score) + lexiconWeight × min(命中词数, lexiconCap)
score(t, c) = min(1, raw)
若 L3 命中 → score(t, c) = score × (1 − penalty)      // 默认 ×0.3
命中判定: score ≥ threshold（默认 0.6）
```
- 一条评论**可同时命中多类**。
- `exclude`（类型级）命中 → 该类型分数**归零**。

### 7.3 证据要求（不可省）
每条命中必须能出示：
- 命中的**规则来源**（`pattern:<正则>` / `lexicon:<词>`）
- 命中的**原文片段与字符区间**
- 若被降权，说明原因

> 没有证据的命中一律不输出 —— 这是公信力的底线。

---

## 8. 可选 AI 层

### 8.1 契约
`--ai <spec>`，仅在**显式指定**时启用。默认 `none`。

| spec 形式 | 说明 |
|---|---|
| `openai:<baseUrl>#<model>` | 任意 OpenAI 兼容端点（含国内各家） |
| `ollama:<model>` | 本地 Ollama，默认 `http://127.0.0.1:11434` |

### 8.2 职责边界（关键）
AI **只做精排，不做召回**：
1. Detector 先用规则算出候选（`score ≥ threshold × 0.5`）。
2. 只把**候选评论 + 其所属类型的定义与示例**发给模型，要求返回「确认 / 否认 + 一句话理由」。
3. 模型返回解析失败 / 超时 / 无网络 → **静默降级**，保留规则原判。

这样即使模型很笨、很贵或不存在，工具依然可用；token 消耗也只与命中数成正比，不随评论总量增长。

### 8.3 严禁
- 不允许把**全量评论**喂给模型（成本爆炸，且会让工具变成"必须有 AI 才能用"）。
- 不允许让模型**新增**规则之外的类型。

---

## 9. 平台适配（v1）

### 9.1 B 站（实现）
1. 解析输入：完整 URL / `BV` 号 / `av` 号 → `bvid`
2. `/x/web-interface/view?bvid=` → `aid`（顺带取标题、UP 主）
3. `/x/web-interface/nav` → `wbi_img` → `imgKey` / `subKey`
4. 每次请求前算 WBI 签名（`wts` 用当前秒）
5. `/x/v2/reply/wbi/main`，`ps=30` / `mode=2`（按时间）/ `pagination_str={"offset":...}`
6. `cursor.pagination_reply.next_offset` 为空或 `is_end` → 结束
7. 节流默认 120ms/页；失败指数退避 3 次（800/1600/2400ms）

**终止条件必须是 `is_end` 或 `next_offset` 为空**，不能靠"条数够了"。

### 9.2 小红书（v1 只留骨架）
```
adapters/xiaohongshu.js  → 抛 NotImplemented，附一段注释说明：
   - 接口 edith.xiaohongshu.com/api/sns/web/v2/comment/page
   - 需要 x-s / x-t 前端签名 + 通常需要登录 cookie
   - 签名算法随前端版本变动，维护成本高
```
文档里明确写：**小红书需要登录态与签名，v1 未实现**（与 B 站免登录形成对照，本身就是视频里的一个知识点）。

---

## 10. CLI 契约

```
node huashu.js <url|bvid|av号> [options]

  --out <path|->       CSV 输出路径；'-' 表示写到 stdout；默认 huashu-<bvid>-<时间戳>.csv
  --rules <path>       自定义规则文件（默认内置）
  --pack <name>        规则包：common(默认) | event-deepseek | all
  --types T1,T2        只跑指定类型
  --min-score <n>      阈值，默认取规则文件
  --max-comments <n>   抓取上限（默认不限）
  --delay <ms>         页间隔，默认 120
  --cookie <str>       显式携带 cookie（默认不带，见 B7）
  --ai <spec>          可选 AI 精排（见 §8）
  --quiet              只输出 CSV，不打摘要
  --json               摘要以 JSON 输出（便于二次处理）
  --no-color           关闭 ANSI 颜色
  --help / --version

退出码:  0 成功 | 1 用法错误 | 2 网络/接口失败 | 3 规则文件无效 | 4 无命中(仍算成功，见下)
```
> 注：**无命中时退出码按 0 处理**（"没有话术"是合法结果）；退出码 4 保留不用。

---

## 11. 输出契约

### 11.1 终端摘要（示意）
```
话术透镜 v1 · BV1bKab6CE56
《DeepSeek究竟是男是女？一条大肥鱼引发的圈地大战》
─────────────────────────────────────────────
抓取  主评论 1802 条｜总评论 6826 条(含楼中楼 5015)｜18.0s｜0 错误
识别  命中 412 条 (22.9%)｜规则 default v1｜阈值 0.60
─────────────────────────────────────────────
T1  和稀泥型      118 条   6.5%  ████████████
T2  假中立型       96 条   5.3%  ██████████
T7  信息茧房型     71 条   3.9%  ███████
T6  扣帽·性别      54 条   3.0%  ██████
T5  扣帽·软色情    38 条   2.1%  ████
T8  胜利后劝和     35 条   1.9%  ████
─────────────────────────────────────────────
⚠ 本结果由当前规则匹配得出，不是事实判定，请结合原文人工复核。
CSV: ./huashu-BV1bKab6CE56-20260930-1201.csv
```

### 11.2 CSV 字段
```
rpid,user,like,ctime,time,msg,hits,max_score,evidence,guarded,guard_note
```
- `msg` 做 CSV 转义（双引号翻倍），换行归一为空格。
- `evidence` 形如 `T1:pattern(两边.{0,8}都.{0,8}有问题)@12-24;T1:lexicon(理中客)@3-5`
- 编码 **UTF-8 with BOM**（否则 Excel 打开中文乱码）。

### 11.3 免责声明（硬性）
摘要**末尾固定输出**，且 `--json` 时也要带一个 `disclaimer` 字段：

> 本结果由当前规则匹配得出，不是事实判定，请结合原文人工复核。

---

## 12. 非功能需求

| 项 | 要求 |
|---|---|
| 依赖 | **零第三方运行时依赖**（仅 `node:crypto`/`node:fs`/`node:url` + 全局 `fetch`） |
| Node 版本 | ≥ 18.17（fetch 稳定），README 建议 20+ |
| 平台 | Windows / macOS / Linux 一致可用 |
| 体积 | 单入口文件 ≤ 60KB（不含规则 JSON） |
| 网络鲁棒性 | 每页最多重试 3 次，指数退避；连续失败即中止并在摘要里标注 `errorCount` |
| 可测试性 | **Fetcher 与 Detector 都必须接受注入**：Fetcher 接受 `fetchImpl`，Detector 是纯函数 —— 单测不需要网络 |
| 可读性 | 关键路径有中文注释；README 面向"不会编程的人"写三步走 |

---

## 13. 风险与缓解

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | B 站改 WBI 签名算法 | 中 | **致命**（抓不到） | 签名集中在单模块；失败时给出明确报错与升级指引；README 写明"接口可能随时变" |
| R2 | 风控加严 / 触发 -352 | 中 | 部分数据 | 默认节流；退避重试；`--cookie` 兜底；报告标注 errorCount |
| R3 | 用户误读"抓漏了" | **高** | 信任崩塌 | 摘要**同时**显示主评论数与 all_count（B4） |
| R4 | 误报伤及无辜 | **高** | 道德/传播 | 免责声明 + 证据可追溯 + 阈值可调 + README 写清"这是筛子不是判决" |
| R5 | 被当成攻击武器 | 中 | 生态 | 中立性约束（§1.3）；两边都识别；不提供挂人功能 |
| R6 | 规则过拟合本次事件 | 高 | 工具寿命短 | 规则分包 `common` / `event-*`（§6.1） |

---

## 14. 里程碑与验收

| 阶段 | 交付 | 验收标准 |
|---|---|---|
| **M1** | Fetcher + 原始 CSV（无识别） | 真跑 3 个视频，主评论完整度 ≥ 98%（用 §2-B3 的方法核算）；0 崩溃 |
| **M2** | RuleSet + Detector + 9 类默认规则 + 终端摘要 + 标注 CSV | 人工抽查 30 条命中，准确率 ≥ 80%；误报能被 `exclude` 或调阈值压住 |
| **M3** | 自定义规则 + AI 钩子 + 小红书骨架 + README + 发布 | 换一份 `my-rules.json` 能跑通；无网络/无 AI 时静默降级不崩 |

---

## 15. 开放问题（待主人拍板）

- **O1 项目正式名**：`huashu-lens` 只是占位。要不要更"能出圈"的名字？
- **O2 视频里要不要演一次误报**：主动展示"这里判错了，调阈值就好"能极大提升可信度，但要花镜头。
- **O3 默认规则包**：默认只装 `common`，还是 9 类全装？（我倾向 common 默认 + event 用 `--pack`）
- **O4 Reporter 是否独立成模块**：只有一处调用，按"删除测试"它可能是浅模块。**留给评审 agent 判**。
- **O5 是否要 `--limit-like`（只分析高赞）**：高赞话术影响更大，但会漏掉长尾。

---

## 附录 A · 与主人已确认的约束对照

| 主人要求 | 落点 |
|---|---|
| 报告只给终端摘要 + CSV | §11 |
| 先主评论 | §1.2、§9.1 |
| 不加立场轴，只声明结果需肉眼识别 | §11.3 |
| 源码 GitHub，A 档（Node 单文件） | §12 |
| 小红书留接口 | §9.2 |
| 留自定义话术/规则口子 | §6 |
| 允许接 API 或本地模型，没有就默认规则 | §8 |
| 中立、不做弹药库 | §1.3 |
