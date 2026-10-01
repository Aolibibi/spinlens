# 数据：本项目不附带任何爬取语料

## 一句话

**本仓库一条评论数据都没有。** 所有的实测语料（约 2 万条评论）、人工标注、
训练数据与模型权重都留在开发者的本机 `lab/` 目录下，已在 `.gitignore` 中排除。

这不是偷懒，是刻意的：B 站评论是**真人写的、带用户名和可点回的原文链接**的内容，
把它们打包进一个公开仓库既不合适也没必要。

---

## 那别人 clone 下来能跑什么？

能跑。**网页界面本身完全不需要任何数据**：

```bash
node server.js            # → http://127.0.0.1:8787
```

粘一个 B 站视频链接就能出结果——**评论是当场抓的，不依赖仓库里任何语料**。

也可以完全不联网先体验：

```bash
node huashu.js --demo           # 用内置 12 条示例短句
node huashu.js --selftest       # 24 条规则原型夹具
node tests/eval.js              # 20 条虚构样本的混淆矩阵
```

这三条用的是**短句片段 / 完全虚构的句子**（不含用户名、评论 ID、链接），随仓库发布。

---

## 怎么准备你自己的数据

### 1. 抓你关心的视频

用工具自带的抓取能力（就是网页版背后那套，免登录、免 cookie）：

```bash
# 命令行：抓一个视频、结果落成 CSV
node huashu.js BV1xxxxxxxxx --out 我的数据/BV1xxxxxxxxx.csv

# 想抓多几个就写个循环，别太猛，加 --delay 免得被风控
node huashu.js BV1xxxxxxxxx --out 我的数据/BV1xxxxxxxxx.csv --delay 400
```

> ⚠️ **抓下来的东西不进仓库。** 建一个你自己的目录（例如 `我的数据/`），
> 并把它加进 `.gitignore`，或者干脆放在仓库外面。

### 2. 人工标注

标注是唯一"真值"来源，也是本项目最大的瓶颈（见最后一节）。

建议格式：一行一条，`rpid` + 命中类型，分号分隔。参考 `tests/golden-demo.csv`：

```csv
rpid,types
123456789,T1;T7
123456790,
123456791,T3
```

类型编号见 `rules/event-deepseek.json`（T1–T9）。

### 3. 接进回归工具

`tools/regress.cjs` 是改规则时的第一道闸门，它默认去 `lab/` 找数据，
你可以用环境变量指到自己的数据：

```bash
# Windows cmd
set HUASHU_DEV_RAW=我的数据/dev-raw.json
set HUASHU_HOLDOUT_CSV=我的数据/holdout-comments.csv
node tools/regress.cjs

# macOS / Linux
export HUASHU_DEV_RAW=我的数据/dev-raw.json
export HUASHU_HOLDOUT_CSV=我的数据/holdout-comments.csv
node tools/regress.cjs
```

- `HUASHU_DEV_RAW`：一个含 `{ "comments": [ ... ] }` 的 JSON
- `HUASHU_HOLDOUT_CSV`：评论 CSV（`huashu.js --out` 产出的格式）

缺哪套数据就自动跳过哪套，不会崩。

---

## 想训练自己的模型？

`local` 引擎需要一个 **Erlangshen-110M 多标签分类器**（8 类：T1–T7 + T9）的权重，
权重约 400MB，不随仓库发布。推理服务脚本 `lab/train/serve-erlangshen.py` 与训练脚本
在开发者的 `lab/` 里（同样未发布）。

你可以：
- 自己准备语料 + 标注，照着 `apply_info.json` 里的超参训练一份；
- 或者干脆跳过本地模型，用 **LLM 模式** 或 **决策模型模式**——功能上是完整的，只是准确率不同。

---

## ⚠️ 最后一句诚实话：标注本身就不牢

在本项目的实测里，**三方独立标注者之间的一致性只有 Krippendorff α = −0.036**
（比随机还差）。也就是说，「这条评论算不算话术」这件事，**连人类之间都对不齐**。

带来的直接后果：

1. 任何在此之上的模型指标（包括 README 里那些 P/R 数字）**都只能当量级参考**；
2. **本项目无法宣称任何"绝对准确率"**；
3. 你自己标的数据也会有同样的问题——**这很正常**，它反映的是"话术"这个概念本身的边界模糊。

所以：**把它当粗召回源，输出必须人工复核。** 不要拿它的结果去指责任何人。

---

## 红线

- 不要把你抓下来的评论语料（尤其带用户名的）直接公开或打包上传。
- 要公开数据时用 `--anon` 把用户名换成不可逆短哈希。
- 本工具**不提供**批量循环挂人功能，也请勿用它围攻具体的人。
