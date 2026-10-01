# 发布模型权重（spinlens v1.0）

本文只讲**怎么把已经整理好的权重传上去**。权重目录是 `dist/model-spinlens-v1.0/`，
里面的 model card（`README.md`）与标签表（`LABELS.md`）已经写好，不用再改。

---

## 0. 要传的东西

```
dist/model-spinlens-v1.0/
├── README.md               model card（HF 会把同名文件渲染成模型页）
├── LABELS.md               8 类 id → 名称 → 定义
├── LICENSE                 MIT（与主仓一致）
├── config.json             模型结构 + id2label（8 类顺序）
├── model.safetensors       ★ 权重本体，约 390 MB
├── tokenizer.json          分词器
├── tokenizer_config.json   分词器配置
└── apply_info.json         训练溯源（模式/轮次/学习率/标签快照）
```

**共 8 个文件，约 390.6 MB（权重占绝大部分）。**

> 没有 `vocab.txt`：这个分词器是 fast tokenizer，词表已经在 `tokenizer.json` 里，**不需要**额外放 `vocab.txt`。

---

## ⚠️ 红线：**绝对不要把权重 commit 进 git**

约 390 MB 的 `model.safetensors` 直接 commit 会把仓库撑爆，具体后果：

| 限制 | 数值 | 后果 |
|---|---|---|
| GitHub 单文件硬上限 | **100 MiB** | 超过 → **push 直接被拒**（不是警告，是失败） |
| GitHub 警告阈值 | 50 MiB | 超过 → 每次提交都告警 |
| GitHub Release 单个附件 | **2 GiB** | 390 MB 完全放得下 ✅ |
| Hugging Face 单文件 | 官方上限远大于此 | 390 MB 完全放得下 ✅ |

**好消息：本仓库已经防住了这件事。** `dist/` 整目录在 `.gitignore` 里，权重文件类型也被单独排除。实测确认：

```bash
# 会打印出命中的忽略规则，说明不会被提交
git check-ignore -v dist/model-spinlens-v1.0/model.safetensors
# → .gitignore:35:dist/   dist/model-spinlens-v1.0/model.safetensors

git check-ignore -v dist/model-spinlens-v1.0/README.md
# → .gitignore:35:dist/   dist/model-spinlens-v1.0/README.md
```

**所以：权重走 Release 或 HF，仓库里只提交文档和小文件。**

---

# 路线 A：Hugging Face（推荐）

**为什么推荐**：模型社区的标准做法。HF 会**自动渲染** `README.md` 里的 model card，
带模型卡元数据（license / base_model / tags），别人能直接 `from_pretrained("<用户名>/spinlens")` 一行加载，
也有版本历史、讨论区、下载统计。**对「发布一个模型」这件事，它是专用工具。**

### A1. 装命令行

```bash
pip install -U huggingface_hub
```

### A2. 登录

```bash
hf auth login
```

粘贴 **HF 的 access token**（在 HF 网站的 Settings → Access Tokens 里建一个，权限选 **Write**）。

> **命令改名说明**：新版把 `huggingface-cli` 改成了 `hf`。旧命令 `huggingface-cli` 仍然能用（它现在是个兼容壳），
> 但**新写法是 `hf`**。下面全部用 `hf`，旧命令等价替换即可（`hf auth login` ↔ `huggingface-cli login`、`hf upload` ↔ `huggingface-cli upload`）。
>
> **本机已知坑**：如果你用项目旁边那套**便携版嵌入式 Python**（就是启动本地推理服务用的那个），
> 它的 `hf` 命令会因为**缺 `venv` 模块**直接报错 `ModuleNotFoundError: No module named 'venv'`。
> 这不是你操作错了——**换一个正常安装的 Python 3.10+ 来跑 `pip install -U huggingface_hub` 就行**，
> 或者用下面的 Python API 方式（那条路不碰 `venv`）。

### A3. 建仓库（可选，但建议先建）

```bash
hf repo create spinlens --repo-type model
```

> 仓库 id 会带上你的用户名，最终形如 `<你的HF用户名>/spinlens`。
> （`hf upload` 在仓库不存在时通常也会自动创建，但先显式建一次最稳。）

### A4. 上传

```bash
hf upload <你的HF用户名>/spinlens ./dist/model-spinlens-v1.0 . --repo-type model
```

参数含义：`<仓库id> <本地目录> <传到仓库里的目标路径> --repo-type model`。
上面的 `.` 表示「目录内容传到仓库根目录」，这样 `README.md` 才会被当成模型卡渲染。

**如果上传中断或嫌慢**（390 MB 单文件，官方给了专门的大目录断点续传命令）：

```bash
hf upload-large-folder <你的HF用户名>/spinlens ./dist/model-spinlens-v1.0 --repo-type model
```

**不想用命令行**，等价写法（这个不依赖 `venv`，本机也能跑）：

```python
from huggingface_hub import HfApi

api = HfApi()
api.create_repo("spinlens", repo_type="model", exist_ok=True)
api.upload_folder(
    repo_id="<你的HF用户名>/spinlens",
    folder_path="dist/model-spinlens-v1.0",
    repo_type="model",
)
print("done")
```

### A5. 验证

```bash
hf download <你的HF用户名>/spinlens config.json --repo-type model
```

或者直接打开网页 `https://huggingface.co/<你的HF用户名>/spinlens`，确认 **model card 渲染出来了**、
文件列表里有 `model.safetensors`。

### A6. 国内网络慢怎么办

HF 有公益镜像。设一个环境变量即可（只影响下载/上传的端点）：

```bash
set HF_ENDPOINT=https://hf-mirror.com      # Windows cmd
export HF_ENDPOINT=https://hf-mirror.com   # macOS / Linux
```

> 注意：镜像主要服务**下载**；**上传**是否可用取决于镜像站，上传建议挂代理走官方端点。

---

# 路线 B：GitHub Releases（不用 HF 账号）

**为什么用它**：不额外注册账号，附件挂在已有的 GitHub 仓库下，下载链接就是 GitHub 的域名。
**代价**：GitHub 不会渲染 model card，别人也不能 `from_pretrained` 一行加载，得手动下文件。

### B1. 装 gh 命令行

**本机实测：`gh` 还没装。** 先装（Windows）：

```bash
winget install --id GitHub.cli
```

装完**重开一个终端**（让 PATH 生效），然后：

```bash
gh auth login
```

按提示选 `GitHub.com` → `HTTPS` → `Login with a web browser`，浏览器里授权即可。

### B2. 打 tag + 建 Release + 挂附件（一条命令）

```bash
gh release create 0.0.1-bigfisho7 \
  dist/model-spinlens-v1.0/model.safetensors \
  dist/model-spinlens-v1.0/config.json \
  dist/model-spinlens-v1.0/tokenizer.json \
  dist/model-spinlens-v1.0/tokenizer_config.json \
  dist/model-spinlens-v1.0/apply_info.json \
  dist/model-spinlens-v1.0/README.md \
  dist/model-spinlens-v1.0/LABELS.md \
  --title "spinlens v1.0 话术识别模型权重" \
  --notes "Erlangshen-Roberta-110M 微调，8 类多标签话术分类。未做严格人工统计，作者体感准确率约 70%，**只当粗召回源，必须人工复核**。用法与限制见 README.md。"
```

> 单条命令挂 7 个附件。Release 的附件**不计入仓库体积**，也不会被 git 历史记录，
> 所以 390 MB 挂在这里是安全的（上限 2 GiB/附件）。
> 想顺带自动生成变更日志，可以去掉 `--notes` 换成 `--generate-notes`。

### B3. 没装 gh？网页上传也行

1. 先把 **tag 推上去**（Release 是挂在 tag 上的）：
   ```bash
   git tag 0.0.1-bigfisho7
   git push origin 0.0.1-bigfisho7
   ```
2. 打开仓库页 → 右侧 **Releases** → **Draft a new release**
3. **Choose a tag** 选 `0.0.1-bigfisho7`
4. 标题填 `spinlens v1.0 话术识别模型权重`
5. 说明框里粘贴上面那段验收数字与免责
6. **Attach binaries** 区域，把 `dist/model-spinlens-v1.0/` 里的文件**逐个拖进去**
7. 点 **Publish release**

> 注意：网页上传**不要**图省事只传 `model.safetensors`——别人拿到一个没有 `config.json`
> 和分词器的权重是跑不起来的。**8 个文件都传**，或者至少把权重 + config + 两个 tokenizer 文件传全。

---

# 两条路怎么选

| | **Hugging Face**（推荐） | **GitHub Releases** |
|---|---|---|
| 要账号 | HF 账号 | 已有 GitHub 账号即可 |
| model card 渲染 | ✅ 自动渲染 `README.md` | ❌ 只是附件，不渲染 |
| 一行加载 | ✅ `from_pretrained("<用户>/spinlens")` | ❌ 得手动下文件、指本地路径 |
| 版本 / 下载统计 / 讨论区 | ✅ 有 | 附件版本有，其余较弱 |
| 单文件上限 | 远大于 390 MB | 2 GiB / 附件 |
| 计入仓库体积 | 否 | **否**（Release 附件不计） |
| 国内访问 | 需镜像或代理 | 通常更稳 |

**建议：两条都做。** HF 给模型社区用（能被 `from_pretrained` 直接拉），
GitHub Release 给不想注册 HF 的人用。反正权重是同一份目录，传两次而已。

---

# 传完之后

1. **回填链接**：把 HF 模型页 / Release 页的地址填进主仓 `README.md` 的「下载模型」小节
   （该小节现在留的是 `https://github.com/Aolibibi/spinlens/releases/tag/0.0.1-bigfisho7` 占位符，把两行链接补上即可）。
2. **跑一遍自检**（确认新加的文档没带本机路径 / 密钥残留）：
   ```bash
   node tools/preflight.cjs
   ```
   全绿才提交。
3. **确认 `dist/` 没被提交**：
   ```bash
   git status --short
   ```
   `dist/` 不该出现在里面。
4. **检查 model card 在 HF 上的渲染**：YAML 头部是否会因为缩进问题报错——打开网页肉眼看一眼最稳。

---

# 需要你拍板的事

| # | 事项 | 说明 |
|---|---|---|
| 1 | **HF 用户名** | 命令里的 `<你的HF用户名>` 需要你填。HF 用户名**不一定**等于 GitHub 的 `Aolibibi` |
| 2 | **模型仓库叫 `spinlens` 还是别的** | 当前按 `spinlens` 写 |
| 3 | **走哪条路 / 是否两条都做** | 建议两条都做，但 Releases 会占你的仓库「Releases」栏 |
| 4 | **tag 名** | 当前按 `0.0.1-bigfisho7`（和代码版本 `v1.0.0` 区分开） |
| 5 | **HF 仓库可见性** | 默认公开；要私有就加 `--private` |

---

# 相关文档

- 示例与实测概率：[docs/EXAMPLES.md](EXAMPLES.md)
- 权重目录与 model card：`dist/model-spinlens-v1.0/README.md`
- 标签定义：`dist/model-spinlens-v1.0/LABELS.md`
