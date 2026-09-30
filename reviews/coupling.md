# 模块耦合性与设计质量审查 · huashu-lens

> **后记（改名）**：本项目已定名 **spinlens · 话术照妖镜**。本文档写于定名之前，正文保留当时的名称，不改写历史。

- 审查对象：`SPEC.md`（v1 · 状态「待主人审阅」）
- 审查范围：模块划分、耦合方向、Seam 真伪、可测试性
- **不覆盖**：规则词表/正则的内容质量、检测准确率、抓取数据正确性、CLI 文案与视频脚本
- 术语：严格使用 codebase-design 的 **Module / Interface / Implementation / Depth / Seam / Adapter / Leverage / Locality**
- 严重度：**BLOCKER**（不解决会当场翻车）｜**MAJOR**｜**MINOR**｜**NIT**
- 每条发现都标注 **[写错了]**（规格内部矛盾/判断错误）或 **[没写]**（规格留白，实现者必然要自己拍）

---

## 0. 一句话结论

**模块划分的方向是对的，但深度是"声明出来的"，不是"接口保护出来的"。**

Fetcher 和 Detector 是真深模块，这一点我不含糊。但这份规格有一个系统性缺陷：**凡是"谁来做"没被明确认领的职责，默认全部落进 CLI**。我把 §4.1 的模块表跟各章行为逐条对照，数出 **7 项无归属职责**（errorCount 汇总、ReportMeta 组装、CSV 文件名与「CSV:」行、AI 精排调用与降级、--pack/--rules 优先级、截断上报、BOM 落地）。照这份规格实现下去，CLI 会从"参数解析 + 错误提示 + 退出码"膨胀成 200 行的杂物间——§4.1 给 CLI 的那行描述会变成谎言。

这不是"过度设计"，恰恰相反：**是划分完之后没有把剩下的工作分配完**。

---

## 1. §4.1 模块划分：五个模块逐个做删除测试

删除测试问的不是"有几个调用方"，而是"**删掉它，复杂度会不会在别处重现，以及重现地是不是更糟**"。

| 模块 | 删除后复杂度去向 | 判定 | 深度评估 |
|---|---|---|---|
| **Fetcher** | WBI 签名（MD5 + w_rid + wts 重排）、游标翻页、节流、退避、终止判定全部落进 CLI | ✅ **保留** | **真深模块**：一个 fetchComments 背后是整个项目最难的一段协议逆向 |
| **RuleSet** | 分包加载 / 版本校验 / 默认值填充 / 正则预编译 / 警告收集，落进 CLI 或 Detector | ✅ **保留，但风险最高** | **潜力型浅模块**：见 §1.2 |
| **Detector** | L1/L2/L3 + 打分 + 语境排除 + 证据剪辑，落进 Reporter 和 CLI（两处，更糟） | ✅ **保留** | **真深模块**：(comments, ruleSet) → Hit[] 是全场性价比最高的 Interface |
| **Reporter** | 终端排版 + CSV 转义 + BOM + 证据序列化 + Hit↔Comment join | ✅ **保留**（明确裁决见 §4） | 按现规格是**浅模块**；改接口后可变深 |
| **CLI** | 无—— CLI 就是 Composition Root，删了它没人组装 | ✅ **保留** | Interface 形状正确（main(argv)），但它是本规格的**垃圾桶** |

### 1.1 已验证无误：Comment[] 是正确的中介

§4.2 的约束句「Detector 不知道数据来自 B 站，Fetcher 不知道什么是话术，二者通过 Comment[] 解耦」——**方向完全正确**，而且是全场唯一的"用纯数据切断依赖"的设计。这是它比我预期更专业的地方。

**但对这句话的措辞我有一处保留 [MINOR·写错了]**：Comment 里的 isPinned（置顶）和 rcount（楼中楼数）**就是 B 站接口语义**。"Detector 不知道数据来自 B 站"在**字段层面**已经不成立了。

**怎么改**：§5 的 Comment 段末补一句：

    【补】本结构是各平台字段的归一化投影，字段语义按来源平台定义。Detector 不得依赖任何
    平台特有字段的存在性：缺失时置 0/false，不得以"字段不存在"作为分支条件。

一句话，把"看起来中立"变成"契约上中立"。

### 1.2 RuleSet 是唯一"可能变浅"的模块 [MAJOR·没写]

§4.1 说它隐藏"文件解析 / schema 校验 / 默认值填充 / 版本兼容"，但 §6.1 把这四件事分散写了，**没有指名谁做**。

**为什么是问题**：如果实现者只写 JSON.parse(readFileSync(path))，那 RuleSet 就是 **3 行 Implementation + 3 个语义的 Interface**——教科书级浅模块，删除测试立刻失败（复杂度不会重现，因为没有复杂度）。

**怎么改**：§6.1 每条后面显式挂责任人，例如：

    【补】缺失字段用默认值 → RuleSet 负责合并内置默认值，Detector 拿到的 RuleSet 永远是填满的
         （Detector 不得写 ?? 0.6 这类兜底）。
    【补】patterns[].re 编译失败跳过并警告 → RuleSet 在 load 时预编译正则，并把警告以
         warnings[] 返回（见 §5 的 F6）。

这两条一挂，RuleSet 的 Implementation 立刻有实质内容，且"默认值只填一次"这件事有了 **Locality**。

---

## 2. §4.2 依赖方向图：无环是真的，但图是错的

### 2.1 直接回答"有没有隐藏的双向依赖"

**没有 import 环，也没有反向依赖。** 但这是因为**这幅图根本不可能出现环**：五个模块里四个是纯数据生产者/消费者，唯一的组合者是 CLI。一张"星形图"声明自己"严格单向"，信息量为零——它成立得太便宜了，以至于**没检查出真正的问题**。

### 2.2 图缺两条边 [MAJOR·写错了]

§4.2 画的是：

    CLI ──> Fetcher ──> Comment[]
     ├──> RuleSet ──> RuleSpec
     ├──> Detector(Comment[], RuleSpec) ──> Hit[]
     └──> Reporter(Hit[], meta) ──> string

对照 §5 的 Hit 字段（rpid / types[] / maxScore / guarded / guardNote）和 §11.2 的 CSV 表头（rpid,user,like,ctime,time,msg,hits,max_score,evidence,guarded,guard_note）：

- user、like、ctime、msg 全是 **Comment 字段，Hit 里没有** → **缺边 Comment[] ──> Reporter**
- §11.1 摘要是要打「T1  和稀泥型」，§11.2 的 hits 列也要类型名 → 类型名在 **RuleSet 里，Hit 里没有** → **缺边 RuleSet ──> Reporter**

**为什么是问题**：这不只是画漏了。按这幅图实现，Reporter 拿到 Hit[] **无法完成 §11 的任何一行输出**。实现者只有两条路：(a) 给 Reporter 加参数（图失效）；(b) 让 Detector 把 Comment/RuleSet 数据塞进 Hit（图失效）。无论哪条，§4.2 作为"实现说明书"是失效的。

### 2.3 回答"Reporter 是否间接耦合了 Fetcher"

**是——但耦合的不是代码，是数据，而且真正的病在别处。**

ReportMeta 的字段来自三个不同模块：

| ReportMeta 字段 | 谁产出 |
|---|---|
| target / title / aid / bvid | Fetcher（view 接口） |
| mainCount / allCount / rcountSum / elapsedMs / errorCount | Fetcher（翻页簿记） |
| ruleVersion / threshold | RuleSet |

而 **§5 定义了 ReportMeta 这个类型，§4.1 没有分配任何一个模块负责构造它** → 它由 CLI 手工组装。

这就是 **Locality 失效**：想给摘要加一个字段，要改三个文件——Fetcher 暴露它、CLI 传递它、Reporter 渲染它。删除测试对这种"以字段形式散落的复杂度"完全失效（复杂度不以代码形式聚拢，所以删哪个模块都不会重现）。

**判定**：不是循环依赖，是**无主类型**。修法见 §5 的 F1。

---

## 3. §4.3 "两个 adapter 原则"三堂会审

「One adapter means a hypothetical seam. Two adapters means a real one.」逐条判：

### 3.1 平台采集（bilibili / xiaohongshu）→ **假 Seam** [MAJOR·写错了]

规格自己承认 xiaohongshu 是「v1 只留骨架」，并且 §9.2 明写实现是抛 NotImplemented。

**三重否决**：

1. **唯一的第二个 Adapter 在构造上不可运行**——一个永远抛异常的 Adapter 不是 Adapter，是 **stub（占位）**。
2. **这个 Seam 没有选择器**。§10 的 CLI 契约里**没有 --platform**。就算你实现了小红书，用户也无法选中它 → 这是**不可达的死代码**。
3. 因此 §4.3 是 **一个真实 Adapter + 一个 stub**，正好落在"一个 Adapter = 假 Seam"的判据上。

**但我要给一个务实的折中**：附录 A 写了「小红书留接口」，这是**已确认约束**。这里要分清两件事——

- **视频叙事价值**：小红书"要签名 + 要登录" vs B站"免登录"的对照，是 §9.2 自己都说"本身就是视频里的一个知识点"。这段**值钱**。
- **工程设计价值**：一个 throw new Error('NotImplemented') 的文件，扩展性收益为 0。

**怎么改（保留叙事、去掉假 Seam）**：

    §4.3 表格「平台采集」行改为：❌ 假 seam（v1 不建）。
      理由：v1 只有一个真实 Adapter，且 CLI 无 --platform 选择器。
    §9.2 保留，但把 adapters/xiaohongshu.js（抛 NotImplemented）改为「契约文档 + README 段落」：
      列出"第二个平台需要提供什么"（parseTarget / fetchComments / 映射到 Comment 的规则），
      不生成任何 .js 文件。
    真到要接小红书那天，再把 --platform 与 adapters/ 一起加上——那时候 Seam 是真的。

**同时**：--platform 这个 flag 现在也**不要**加进 §10。加一个只有一个取值的 flag，就是给未来的自己挖坑。

### 3.2 AI 精排（none / ollama / openai-compatible）→ **不是 Seam，是缺了一个 Module** [MAJOR·写错了]

两个问题：

**(a) "两个 Adapter"是同一个 Adapter 换了 baseUrl。** §8.1 的 openai:<baseUrl>#<model> 与 ollama:<model>：Ollama 自带 OpenAI 兼容端点（/v1/chat/completions）。如果你走的是那个端点，那两者是**同一个协议 + 两个默认 URL**，真正变化的只是 baseUrl。协议没变，就不是 Seam。none 更不算 Adapter——它是"这条路不存在"，是默认分支，不是实现。

> 反证条件：如果你用 Ollama 的**原生** /api/chat（而非 /v1 兼容端点），那确实是两套协议。但那就意味着你要为同一件事维护两套请求/解析代码——为了一个 v1 里可选的钩子。**不值得**。

**(b) 更严重：§8 描述了一整套行为，但 §4.1 和 §4.2 里没有任何模块承接它。**

§8.2 要求：拿候选 → 拼 prompt（含类型定义与示例）→ 发请求 → 解析"确认/否认 + 理由" → 超时/失败静默降级。这是**几十行真逻辑**。它去哪？

- 放进 Detector → **§12 的"Detector 是纯函数"当场作废**（Detector 里出现网络 I/O），这是规格自己定的可测试性红线。
- 放进 CLI → §4.1 说 CLI 隐藏的复杂度只有"参数解析、错误提示、退出码"。**这行描述变成谎话**。

**怎么改**（选一个，别拖）：

    方案 A（推荐，符合"抛砖引玉"定位）：在 §4.1 模块表新增一行 Refiner，
      Interface：refine(hits, ruleSet, ctx, aiImpl) → hits'
      Implementation：prompt 构造 / HTTP / 响应解析 / 降级
      §4.2 补边 CLI ──> Refiner
      §12 可测试性行补：Refiner 同样接受注入 aiImpl（与 Fetcher 的 fetchImpl 对称），
      降级 = aiImpl 抛错即原样返回。
    方案 B：§8 整章标注"M3 可选，v1 不实现"，并从 §3-S5、§10 的 --ai 中撤下，
      等真要做时连模块一起加。
    —— 无论哪个方案，都不要现在这个状态：行为有了、接口没定、模块没家。

**(c) 顺带 [MINOR·写错了]**：§4.3 把「语义识别后端：规则 / 模型」写为"归入 AI 精排 seam，不新开"。这个判断**是对的**，但 §4.3 同时又把「AI 精排」本身判成 ✅ 真 seam——**结论矛盾**。既然只有一个协议、一个实现，就该按 §4.3 最后一行的精神**降级为 Implementation 内部的注入点（internal seam）**，不是外部 Seam。

> 术语补充（这是 skill 的准确用法）：**Internal seam** 是深模块内部用的小部件、"只为自己测试服务"，**不属于 Interface**。fetchImpl / aiImpl / 时钟注入，全部属于这一类——它们该写进 §12 的可测试性说明，**不该写进 §4.3 的 Seam 表**。§4.3 的标题是"哪些 seam 是真的"，混入 internal seam 会让这张表失去判断力。

### 3.3 报告输出（terminal / csv）→ **真 Seam，但 Interface 形状错了** [MAJOR·写错了]

**Seam 判定：✅ 真**。两个 Adapter **都在 v1 真实存在、都被跑到、共享同一个输入**。这是全场最扎实的一个 Seam。

**但 §4.1 给的 Interface 是错的**：

    report(result, format) → string      // format ∈ {terminal, csv}

对照 §11：**默认流程是同时输出两者**——§11.1 的摘要截图里最后一行就是「CSV: ./huashu-BV1bKab6CE56-...csv」。format 是个**排他选择器**，表达不了"都要"。

**怎么改**：

    renderSummary(model) → string        // 终端摘要（含 §11.3 免责声明）
    renderCsv(model)     → string        // 纯 CSV 文本，不含 BOM（见 §5 的 F9）

CLI 按 flag 决定调哪个/都调。两个函数共享同一个 model，Seam 仍然成立，且**每个渲染器都能用一个字面量 fixture 直接单测**——这就是 "interface is the test surface" 的正确形状。

### 3.4 总表

| Seam | 规格判定 | 我的判定 | 依据 |
|---|---|---|---|
| 平台采集 | ✅ 真 | **❌ 假** | 第二个 Adapter 抛异常 + 无 --platform 选择器 |
| AI 精排 | ✅ 真 | **⚠️ 不是 Seam（是缺一个 Module）** | 同一协议换 baseUrl；且行为无归属模块 |
| 报告输出 | ✅ 真 | **✅ 真**（Interface 需改形） | 两个 Adapter 都在 v1 真实存在 |
| 语义识别后端 | ⚠️ 归入 AI | **✅ 判断正确** | 不该新开 Seam |
| 明确不引入（插件注册表/事件总线/DI 容器/分层配置） | ✅ | **✅ 完全正确** | 见 §8 |

---

## 4. §15-O4 裁决：Reporter 是否独立成模块

### **裁决：独立成模块。保留。但 Interface 必须重写。**

规格自己的怀疑是「只有一处调用，按删除测试它可能是浅模块」。这个怀疑**用错了判据**：

1. **删除测试问的是"复杂度去哪"，不是"几个调用方"。** 删掉 Reporter，落进 CLI 的是：终端排版（表头 + 计数行 + 动态宽度条形图 + 免责声明）**加** CSV 转义（双引号翻倍）、换行归一、UTF-8 BOM、evidence 串拼装（含字符区间）、以及 Hit↔Comment 的 join。这不是"散进 CLI"——是**在 CLI 里重建一个 Reporter**。
2. **"只有一处调用"是错的**：§11.1 的一次运行里有**两个渲染目标**（摘要 + CSV）。两个 Implementation，一个调用点。
3. **判据是 Interface vs Implementation 的比例**。按现规格（report(result, format) + 内部 switch），它确实浅。按修正后（**一个自足输入值 → 一个字符串**），它是深模块。
4. **CSV 转义是全项目单测价值最高的一段代码**：中文评论区满是引号、逗号、换行和 emoji，Excel 里翻车是"当场出洋相"级别的事故。按 "interface is the test surface"，这段逻辑必须能**通过一个 3 行 Interface 直接测到**。若它埋在 CLI 里，测试就必须穿过 argv 解析、退出码、文件写入——**测试被迫穿透到实现内部**，这正是浅/错形状 Interface 的症状。

**结论**：O4 可以关闭了。**保留 Reporter，理由不是"分层好看"，而是"CSV 转义的测试面必须是它自己"。**

---

## 5. 可测试性：§12 的两条承诺不够

§12 写：「Fetcher 接受注入 fetchImpl，Detector 是纯函数 —— 单测不需要网络」。

**方向对，但不足以让"单测不需要网络"成立。** 逐条说：

### F1 [BLOCKER·没写] Fetcher 的 Interface 是"漏的"，装不下 ReportMeta 要的四个数

fetchAll(target, opts) → Comment[]——但 §5 的 ReportMeta 需要 mainCount / allCount / rcountSum / elapsedMs / errorCount，其中 **allCount（来自 cursor）、errorCount（重试/中止统计）、elapsedMs（翻页耗时）全部产生在 Fetcher 内部**。裸数组带不出来。

**为什么是 BLOCKER（不是"洁癖"）**：实现者只有三条路，全都会在演示里出事——

- **(a) 抛异常**：§12/§13-R2 明确要求"连续失败即中止并标注 errorCount"——抛了异常，**已经抓到的 4 页数据全丢**。
- **(b) 模块级计数器**（最诱人的写法）：let errorCount = 0 挂在模块顶层。**在 S3 批量模式下直接出错**：node huashu.js BV1 BV2 BV3 顺序抓 3 个视频，第 3 个视频的摘要会显示**三次抓取累计的 errorCount**。这是可复现、可演示的 bug。
- **(c) 副作用回写 opts**：把统计数字偷偷挂回调用方传进来的对象上。**副作用而不是返回值**——直接违反 "Return results, don't produce side effects"，且测试要断言一个被修改过的入参。

**怎么改**（一处改动，同时解决 F1/F11/F12/§2.3 的无主类型）：

    §4.1 Fetcher 行：
      Interface = fetchComments(target, opts) → FetchResult
      FetchResult { comments: Comment[], allCount, rcountSum, pages, errorCount, errors[],
                    elapsedMs, truncated, suspect, header{target,title,aid,bvid} }
    §5 新增 FetchResult 类型定义（这才是它该在的地方——它由 Fetcher 产出、被 CLI 转交
      Reporter，是一个有主的类型）。
    §4.2 图：Fetcher ──> FetchResult（替换 Fetcher ──> Comment[]）。
    §12 补不变式（关键，用测试能验的句子写）：
      「Fetcher 必须是可重入的：同一进程内对 N 个 target 顺序调用，互不污染
       （S3 批量模式即此用例的直接测试）。Fetcher 内部禁止模块级可变状态。」
    函数名：fetchAll 在中止/截断时会说谎（返回的不是"all"）。改名 fetchComments。

### F2 [BLOCKER·没写] "静默截断"没有守卫 —— 项目最贵的一种失败，规格自己已经证明了它存在

这是我认为**风险最高**的一条，而且**证据就在规格自己的 §2-B2 里**。

- §2-B2 实测：旧端点游客被风控时，返回的是 **3 条 + is_end=true + pagination_reply 为空**。
- §9.1 的终止条件：is_end 或 next_offset 为空 → 结束。
- §13-R1 假设的失败模式：「签名算法变了 → **明确报错** → 升级指引」。

**三者对不上**：实测已证，同类端点在降级时**不报错**，而是**干净利落地返回 3 条并宣布结束**。按现规格，这种情况会被 Fetcher 判为"正常完成"，Detector 正常打标签，摘要正常打印：

    抓取  主评论 3 条｜总评论 6826 条(含楼中楼 5015)｜0.2s｜0 错误
    识别  命中 1 条 (33.3%)｜规则 default v1｜阈值 0.60

用户看到的是**"结果很干净"**，不是"工具坏了"。对一个要发 B 站、要给别人跑的工具来说，**这是最坏的一种失败**：输出看起来完全可信。

**为什么这是 BLOCKER**：§13 把 R1 标为"中概率 / 致命"，但整份规格对这个致命的失败模式**没有任何检测机制**。视频上线三周后接口一变，跑的人不会来提 issue，只会说"这工具瞎标"。

**怎么改**（3 行代码的事，写进规格只需两句）：

    §4.1 Fetcher 行的 Implementation 列，在"终止判定"后追加「可疑截断自检」。
    §9.1 新增第 8 条：
      8. 低可信度自检：抓取结束时，若 comments.length ≤ 3 且 allCount > comments.length
         （或最终 count 远小于 total），判定为疑似被风控降级 / 端点失配，
         置 FetchResult.suspect = true，并在摘要首行打印醒目警告（≠ 普通 errorCount）。
    §11.1 新增一行示意：
      ⚠ 本次抓取仅取得 3 条，疑似接口降级/风控拦截，结果不完整，请勿据此下结论。
    §10 退出码：补「5 抓取结果可疑（疑似被降级）」——让脚本也能判。

这不是"加强健壮性"的空话：**它对应一个已被实测证明存在、且后果最严重的具体故障模式**，且守卫只有一次比较。

### F3 [MAJOR·没写] fetchImpl 的签名与"零真实网络"不变式都没定义

§12 只说了"接受注入 fetchImpl"，没说它长什么样。

**为什么是问题**：(url, init) → Response（假实现要造出带 .json() / .ok / .status 的 Response 对象）和 (url) → any（假实现只返回 JSON，状态码处理藏进 Fetcher 内部）是**两种完全不同的测试面**，fixture 形状完全不同。实现者随手选一个，测试就绑死在那个选择上。

更严重的是**逃逸**：§9.1 要打三类接口（nav / view / reply/wbi/main）。如果实现者给 nav 或 view 用了内部自建的 fetch，**单测里的假 fetch 拦不住它** → 测试真的去打了 B 站。这种测试**会通过**（因为 B 站在线），但在 CI / 断网时随机失败。

**怎么改**（§12 可测试性行补两句）：

    【补】fetchImpl 的契约：
      async (url: string, init: { headers: Record<string,string> })
        → { ok: boolean, status: number, json(): Promise<any> }
      （WHATWG Response 的结构化子集即可，测试无需真 Response）。
      非 2xx 一律按 status 判断，不靠抛异常。
    【补】零真实网络不变式：测试模式下 nav / view / reply 三类请求必须全部经由同一个
      fetchImpl。配一个断言测试：假 fetchImpl 收到未在 fixture 表里的 URL 时抛错
      —— 这条测试就是"没有请求逃逸"的守卫。

### F4 [MAJOR·没写] 缺一个时钟 / sleep 的 internal seam（这是最值钱的一个缺失 Seam）

Fetcher 有三个时间依赖：wts（当前秒）、节流 --delay 120ms/页、退避 800/1600/2400ms。

**为什么是问题（两条）**：

1. **测试慢且脆**：61 页 × 120ms = **7.3 秒**纯等待；一个退避重试用例再加 **4.8 秒**。这份规格一共没几个模块，测试套件却要跑十几秒，还要忍受时间抖动。用 --delay 0 硬压？那是在生产代码里给测试开后门，且丢失了"节流确实生效"的验证能力。
2. **WBI 的黄金测试根本写不出来**：w_rid 依赖 wts。wts = 当前秒 → 输出不可预测 → 测试只能断言"是个 32 位十六进制串"，**这什么都证明不了**。而 §13-R1 把"WBI 算法变了"标为**致命**——你最致命的单点风险，目前**无法被测试保护**。

**怎么改**：

    §12 可测试性行追加：
      Fetcher 还接受两个注入：now() → number（返回毫秒时间戳，默认 Date.now）
      与 sleep(ms) → Promise（默认 setTimeout）。
    §9.1 第 4 条补一句：
      wts 取自注入的 now()（秒级向下取整），不得直接调用 Date.now()。
    §14-M1 验收标准追加一条：
      记录一组真实成功请求的 wts + 参数串 + w_rid 作为黄金向量（按 §2 的方式落盘），
      单测固定 now 后断言签名一致。这条失败 = 立即知道 WBI 变了，而不是等用户
      发现只有 3 条评论。

这一条同时给了 M1 一个**真正有意义的验收标准**（现在 M1 只有"完整度 ≥ 98%"和"0 崩溃"，前者要抓真数据才能测，后者是废话）。

### F5 [MAJOR·没写] main(argv) 没说返回值还是 process.exit

§10 定义了 5 个退出码（0/1/2/3/4），这是 CLI 的**主要测试面**。但 §4.1 只写 main(argv)。

**为什么是问题**：如果 main 内部调 process.exit(2)，那么"用法错误 → 退出码 1"这类测试**只能靠 spawn 子进程**来跑（因为 process.exit 会杀掉测试进程）。5 个退出码 × 5 个子进程测试 = 慢、跨平台脆弱（Windows 上读 exitCode 的方式不同）、还测不到 stdout 内容。

**怎么改**：

    §4.1 CLI 行：main(argv, { stdout, stderr }) → Promise<exitCode>
    §10 备注：main 返回退出码，不调用 process.exit；
      只有最外层入口 process.exit(await main(process.argv.slice(2), process))
    §12 追加：stdout/stderr 默认取 process，测试时传两个字符串收集器
      —— 退出码矩阵与输出内容可以全部在进程内断言。

### F6 [MAJOR·没写] RuleSet 的"警告"没有出口

§6.1 说正则编译失败"跳过并警告"。

**为什么是问题**：警告发给谁？如果 RuleSet 内部 console.warn，这个模块就**耦合到了输出通道**（且测试要劫持 stdout 才能断言"确有一条警告"），同时 §11.1 的摘要里也看不到这条警告——用户永远不知道自己的自定义规则里有 3 条正则根本没生效。这是"静默失效"，最坑用户。

**怎么改**：

    load(spec) → { ruleSet, warnings: string[] }（§4.1 RuleSet 行同步改），
    warnings 由 CLI 输出（--quiet 下也必须输出到 stderr），--json 时进 warnings 字段。

### F7 [MINOR·没写] 字符区间的计数单位（码点 vs UTF-16）

§7.3 要求给出"原文片段与字符区间"，§11.2 的 evidence 形如 @12-24，§6 的 negationWindow: 12 也是"前 N 字"。

**为什么是问题**：JS 的 str.slice 按 UTF-16 单元。B 站评论里 emoji（😅🔥）占 2 个单元 1 个码点。任何一条带 emoji 的评论，**证据区间与用户肉眼数出来的位置会对不上**——而 §7.3 说"证据可追溯是公信力的底线"。negationWindow 同理（可能把否定词算漏 1 个字）。

**怎么改**：§5 的 Hit.evidence 字段后加一句：

    【补】区间一律按 Unicode 码点计数（Array.from(msg) 的下标）；实现内部统一先转码点
    数组再匹配与切片。negationWindow 同为码点数。

再补一个测试用例：一条含 emoji 的评论，evidence 区间与 Array.from(msg).slice(start,end).join('') 完全一致。

### F8 [MINOR·没写] Hit[] 与 CSV 行的顺序契约

§7.2 只说了"命中判定 = score ≥ threshold"，没说：Hit[] 是每条评论一条（§5 的 types[] 暗示是）、低于阈值的类型是否已从 types[] 过滤掉、**数组按什么排序**。§11.2 也没说 CSV 按什么排。

**为什么是问题**：CSV 打开顺序是**用户第一眼看到的东西**。按默认抓取顺序（时间倒序）排 → 打开是一堆 0 赞评论；按 maxScore/like 排 → 立刻有说服力。这是产品决策，不能留给实现者随手决定。

**怎么改**：§5 的 Hit 段后补：

    【补】Hit[]：每条评论至多一条，types[] 已过滤（只含 score ≥ threshold），
    按 maxScore 降序、同分按 like 降序。CSV 行序 = Hit[] 顺序。

### F9 [MINOR·没写] BOM 由谁加 —— 一个"会在视频里出洋相"的模糊点

§11.2 要求「编码 UTF-8 with BOM」，但 §4.1 说 Reporter 返回 string。

**为什么是问题**：BOM 是**字节层**的东西。两条路都有坑：

- Reporter 返回 U+FEFF + csv → --out - 走 stdout 时，BOM 会**污染管道**（用户 | jq / > file 都会吃到它）。
- CLI 加 BOM → **CSV 格式知识分裂在两个模块里**（Reporter 管转义、CLI 管编码），将来改编码要改两处。

**怎么改**：§11.2 补一句：

    【补】renderCsv() 返回不含 BOM 的纯文本；仅当写入文件时由 CLI 前置 U+FEFF
    （--out - 不加）。理由：BOM 是文件字节格式，不是 CSV 内容。

### F10 [MINOR·没写] 模块 ↔ 文件的映射，以及"单文件"和可测试性的冲突

§9.2 引用了 adapters/xiaohongshu.js（**目录结构**），§12 又要求「单入口文件 ≤ 60KB」。这两句放在一起，实现者不知道该建几个文件。

而如果真按"单文件"做，还有个经典陷阱：**单文件 + 顶层解析 argv = 测试 import 它时会直接把 CLI 跑起来**（还可能 process.exit 掉测试进程）。

**怎么改**：

    §12 体积行改述：说明"发行形态为单个 .js 文件（用户下载即用，这是视频里的一个卖点）"，
      且这是打包/交付形态，不是"开发期只能有一个文件"。
    §12 追加一句实现约束：入口文件必须 export 所有模块函数，并把 CLI 执行包在 main guard 里：
        if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(...))
      这样"单文件交付"和"单测能 import"同时成立——不需要为测试拆文件，
      这符合"过度设计是缺点"的定位。

（若最终决定拆多文件，那 §9.2 的 adapters/ 才成立；但那样就得放弃"复制一个文件就能跑"的叙事。**二选一，写明**。）

### F11 [MINOR·没写] opts 的字段与默认值没有落在 Interface 上

按 skill 的定义，**Interface 包含"调用方必须知道的一切"**：不只是类型，还有默认值、不变量、错误模式。fetchComments(target, opts) 里的 opts（delay 120 / maxComments / cookie / fetchImpl / now / sleep）如果不在 §4.1 列明，它就**不是 Interface，是"实现细节的口子"**——调用方（和测试）只能去读实现。

**怎么改**：§4.1 Fetcher 行的 Interface 列，把 opts 的字段与默认值全列出来（6 个，一行够）。

### F12 [MINOR·写错+没写] §9.1 的"终止条件"与 §10 的 --max-comments 表面打架，且截断必须上报

- §9.1 加粗强调：「**终止条件必须是 is_end 或 next_offset 为空，不能靠"条数够了"**」
- §10 却有 --max-comments <n>（抓取上限）

**为什么是问题**：二者其实不矛盾（一个是**自然终止**，一个是**人为截断**），但规格没说，实现者会以为矛盾，选出各种奇怪写法。而且：--max-comments 100 跑完，摘要会打印「主评论 **100** 条｜总评论 6826 条」——**用户会读成"抓全了，只有 100 条"**，这是 §13-R3（用户误读抓漏了，概率=高）的又一个入口。

**怎么改**：

    §9.1 加注：--max-comments 为人为截断，不影响终止条件；
      命中截断时 FetchResult.truncated = true。
    §11.1 加示意行：抓取  主评论 100 条（已按 --max-comments 截断，非全部）｜总评论 6826 条
    §10 退出码对照表补一句：截断/部分成功 → 仍为 0，但摘要必须标注。

### F13 [NIT·写错了] 退出码 4 声明了却不用

§10 定义了 5 个退出码，紧接着注释说"4 保留不用"。**声明一个永不返回的退出码是纯噪音**，而且它占了一个语义槽位——当 F2 真的需要一个"抓取可疑"的退出码时，你会纠结用 4 还是 5。

**怎么改**：从 §10 删掉 4，把 5（抓取可疑）补进去（见 F2）。

---

## 6. 该有却没有的 Seam / 不该有却有的 Seam

| 类型 | 对象 | 判定 |
|---|---|---|
| **该有但没有** | **时钟 / sleep 注入（Fetcher 的 internal seam）** | 缺。这是全场**最值钱**的缺失：没有它，WBI（致命风险 R1）无法被测试保护；有了它，抓取单测从"十几秒 + 抖动"变成"0 秒 + 可断言退避序列" |
| **该有但没有** | **aiImpl 注入 + 承接它的 Module（Refiner）** | 缺。§8 有行为、无模块、无 Interface（见 §3.2） |
| **该有但没有** | **静默截断自检**（不是 seam，是 Fetcher Implementation 内的一段守卫） | 缺。见 F2 |
| **不该有却有** | **xiaohongshu Adapter 文件** | 假 Seam。第二个 Adapter 构造上不可运行，且没有选择器（见 §3.1） |
| **不该有却有** | **--ai 被列为"外部 Seam"** | 只有一个协议，应降级为 internal seam（见 §3.2c） |
| **不该有、规格也确实没加** | 插件注册表 / 事件总线 / DI 容器 / 分层配置 / --platform flag | ✅ **完全正确的克制**，见 §8 |

---

## 7. 发现清单（按严重度，可直接当 checklist）

| # | 严重度 | 性质 | 一句话 | 落到哪一节改 |
|---|---|---|---|---|
| F2 | **BLOCKER** | 没写 | 静默截断（3 条 + is_end，§2-B2 已实测存在）无任何守卫，用户看到的是"结果很干净" | §9.1 第 8 条 + §11.1 + §10 |
| F1 | **BLOCKER** | 没写 | fetchAll → Comment[] 装不下 ReportMeta 的 4 个字段；最省事的写法（模块级计数器）在 S3 批量模式直接出错 | §4.1 + §5 + §4.2 + §12 |
| F5 | MAJOR | 没写 | main 返回退出码还是 process.exit 未定 → §10 的退出码矩阵只能靠 spawn 子进程测 | §4.1 + §10 + §12 |
| F4 | MAJOR | 没写 | 缺时钟/sleep 注入 → WBI 黄金测试写不出来（致命风险 R1 无保护），抓取单测 7.3s+ | §12 + §9.1 第 4 条 + §14-M1 |
| F3 | MAJOR | 没写 | fetchImpl 签名未定 + "零真实网络"不变式未写 → 测试可能偷偷打真接口 | §12 |
| F6 | MAJOR | 没写 | RuleSet 的"警告"没有出口 → 用户的自定义正则静默失效 | §4.1 + §6.1 |
| — | MAJOR | 写错了 | §4.3 判 xiaohongshu 为"真 seam"：第二个 Adapter 抛异常 + 无 --platform 选择器 = 不可达死代码 | §4.3 + §9.2 |
| — | MAJOR | 写错了 | §4.3 判 AI 精排为"真 seam"：同一协议换 baseUrl；且 §8 的行为在 §4.1/§4.2 无归属模块 | §4.3 + §8 + §4.1 |
| — | MAJOR | 写错了 | report(result, format) 是排他选择器，与 §11「摘要 + CSV 同一次运行都要」冲突 | §4.1 + §11 |
| — | MAJOR | 写错了 | §4.2 图缺 Comment[] ──> Reporter 与 RuleSet ──> Reporter 两条边；按图实现 Reporter 无法完成 §11 任何一行 | §4.2 + §5 |
| F12 | MINOR | 写错+没写 | §9.1「不能靠条数够了」与 §10 --max-comments 表面打架；截断未上报 → R3 的又一个入口 | §9.1 + §10 + §11.1 |
| F10 | MINOR | 没写 | §9.2 的 adapters/ 目录 vs §12「单入口文件」矛盾；单文件顶层 argv 会让 import 直接执行 CLI | §12 + §9.2 |
| F9 | MINOR | 没写 | BOM 归 Reporter 还是 CLI 未定；--out - 场景会污染管道 | §11.2 |
| F8 | MINOR | 没写 | Hit[] 基数/过滤/排序 + CSV 行序无契约 → 用户第一眼看到什么，交给实现者随手决定 | §5 + §11.2 |
| F7 | MINOR | 没写 | 字符区间与 negationWindow 的计数单位（码点 vs UTF-16）→ emoji 评论的证据区间对不上 | §5 + §7.3 |
| F11 | MINOR | 没写 | opts 字段与默认值不在 Interface 上 = "实现细节的口子" | §4.1 |
| — | MINOR | 写错了 | §5 的 Comment 含 isPinned/rcount（B站语义），§4.2「Detector 不知道数据来自 B 站」措辞过强 | §5 + §4.2 |
| — | MINOR | 没写 | §6.1/§10 未定义 --rules 与 --pack 同时给出时的优先级 | §6.1 + §10 |
| F13 | NIT | 写错了 | 退出码 4 声明了却"保留不用"（占槽位、无信息） | §10 |

---

## 8. 已验证无误（我认真看过的、认为对的地方，别误以为我漏了）

1. **§4.3 末尾"明确不引入的 seam"（不做插件注册表 / 事件总线 / DI 容器 / 分层配置）** —— **这份规格最有价值的一段**。它把"可扩展"这个陷阱提前关掉了。绝大多数同类小工具死在这里，你没有。
2. **Comment[] 作为唯一中介切断 Fetcher↔Detector** —— 方向完全正确（措辞问题见 §1.1）。用纯数据切依赖，比用接口切依赖便宜得多。
3. **Detector 是纯函数、Reporter 返回 string、CLI 是唯一有副作用的层** —— 副作用集中在最外层的形状是对的，这让 4/5 的模块天然可测。
4. **main(argv) 作为 CLI 的 Interface** —— 形状正确（问题只在返回值/exit，见 F5）。
5. **§9.1 用 mode=2（按时间）翻页** —— 正确。按热度翻页会因重排破坏游标一致性；这是抓全量的必要条件，规格选对了。
6. **§7.3「没有证据的命中一律不输出」** —— 这是把"公信力"写成了不可协商的实现约束，而不是一句愿景。很好。
7. **§2.1 三条红线 + §13 的 R3 缓解（摘要同时打主评论数与 all_count）** —— 产品直觉正确，直接来自实测 B4。（**但 R3 只堵了一半**：API 静默降级那条路没人守，见 F2。）
8. **§11.2 的 CSV 转义 + UTF-8 BOM** —— 细节意识到了，很好（归属问题见 F9）。
9. **§1.2 非目标清单（不做 exe / 不做 GUI / 不做立场判定 / 不引入默认语义模型）** —— 删得干净，符合"抛砖引玉"的定位。
10. **§6.1 规则分包（common / event-*）** —— 这是对抗 R6（规则过拟合事件、工具寿命短）的正确手段。
11. **§8.3 的"严禁"（不给模型喂全量评论、不让模型新增类型）** —— 边界画得对：AI 只做精排不做召回，成本与评论总量脱钩。

---

## 9. 越界一句话（不属我范围，但确实是数错）

§2-B3 的百分比：(1802+5015)/6826 = 6817/6826 = **99.87%**，规格写 **99.5%**；第二条 103/104 = **99.04%**，规格写 **98.3%**。

"缺 9 条"的结论没问题，**只有百分比偏低**。但 §14-M1 的验收标准是"主评论完整度 ≥ 98%"——分母口径摇摆在 98.3% 和 99.04% 之间，会导致验收时不知道自己在比什么。建议 §2-B3 的百分比直接改成计算式的标准写法：(主评论 + Σrcount) / all_count。

---

## 10. 整体判断：这是"深模块设计"还是"把函数分了个类"？

**诚实回答：介于两者之间，且两端都有真货。**

**真货这一端**：Fetcher 和 Detector 是货真价实的深模块。WBI 签名 + 游标翻页 + 退避 + 终止判定，塞在 fetchComments(target, opts) 背后；三层匹配 + 打分 + 语境排除 + 证据剪辑，塞在 detect(comments, ruleSet) 背后。**这两个 Interface 的学成本远低于它们的 Implementation**，这就是 Depth。五个模块里没有一个该删（Reporter 的保留理由见 §4）。

**另一端的三个症状**：

1. **未被认领的工作默认落进 CLI** —— 7 项（见 §0 与 §7）。这是本文档所有 MAJOR 的共同根因。
2. **Seam 表里混进了 internal seam** —— fetchImpl / aiImpl / 时钟属于"深模块内部的测试注入口"，不该跟 terminal/csv 这种真实变体挤在同一张判定表里（§3.2c）。这张表因此从"判断工具"退化成了"设计愿望清单"。
3. **深度靠声明，不靠接口保护** —— §4.1 表格里"隐藏的复杂度"是**承诺**；但 §12 只把"可测试性"给了 Fetcher 和 Detector，**没有一条不变量是可以用接口验证的**（"Fetcher 必须可重入"、"零真实网络"、"返回退出码"、"区间按码点"——全都没写）。**Interface 不是文档里的一句话，是测试能断言的东西。**

**最该记住的一句**：这份规格不需要更多模块，需要的是**把已经划出来的模块边界，用 12 条能被测试断言的不变量钉住**。上面所有发现的修复，加起来大概是规格里加 **40 行文字、0 个新模块**（Refiner 视 AI 是否进 v1 而定），这个成本对一个要发视频的项目是合理的。

### 如果只做 5 个改动

1. **F2** —— 静默截断自检（3 行守卫，防的是"工具看起来正常但结果是错的"）
2. **F1** —— fetchComments → FetchResult（一次改动，同时解决 4 个发现和 ReportMeta 的无主状态）
3. **F4** —— 注入 now/sleep（拿到 WBI 黄金测试，把"致命风险"从不可测变成可测）
4. **§3.2 二选一** —— 要么给 AI 建 Refiner 模块，要么把 §8 从 v1 拿掉（**不要现在这个"有行为没模块"的中间态**）
5. **§3.1** —— 把 xiaohongshu 从"假 Seam 代码"降级为"契约文档"，删掉 --platform 的念想

> 第 5 条顺手证明了这份规格的基本盘是好的：**它最大的问题不是做多了，而是有几个地方没做完。**
