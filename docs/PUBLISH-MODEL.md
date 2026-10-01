# 模型权重：已经发布完了，这里只是记录

**这不是一份操作指南——那件事已经做完了。** 它记录三件事：权重在哪、8 个文件各是什么、万一要重发怎么做。

## 发布在哪

| 项目 | 值 |
|---|---|
| 渠道 | **GitHub Releases**（唯一渠道） |
| tag | `0.0.1-bigfisho7` |
| 页面 | <https://github.com/Aolibibi/spinlens/releases/tag/0.0.1-bigfisho7> |
| 附件 | **8 个文件，合计 390.60 MB** |
| 模型 | Erlangshen-Roberta-110M 微调，8 类多标签（T1–T7 + T9） |

**没有发 Hugging Face，以后也不打算发。** 理由：HF 要额外注册账号、配 token，本机访问 HF 还得挂镜像；
而 GitHub Releases 已经能满足「让人把权重下下来」这一个需求。

## 8 个文件分别是什么

| 文件 | 内容 | 大小 |
|---|---|---|
| `model.safetensors` | **权重本体** | 390.2 MB |
| `tokenizer.json` | 分词器 | 0.4 MB |
| `config.json` | 模型结构 + 类别顺序 | 小 |
| `tokenizer_config.json` | 分词器配置 | 小 |
| `apply_info.json` | 训练溯源（轮次 / 学习率 / 标签快照） | 小 |
| `README.md` | model card（给人看的模型说明） | 小 |
| `LABELS.md` | 8 类的编号 → 名称 → 定义 | 小 |
| `LICENSE` | MIT | 小 |

> 只想要最小可用集？下**前 4 个**就够推理了。其余是说明和许可。

## 为什么权重不放进 git

GitHub 单个文件的硬上限是 **100 MiB**，超了 push 会被直接拒绝。所以权重只能走 Release
（Release 的附件不计入仓库体积，单个附件上限 2 GiB，390 MB 放得下）。

仓库这边也做了防护：`dist/` 整个目录、`model/` 目录、以及权重文件类型都在 `.gitignore` 里。
想验证的话：

```bash
git check-ignore -v dist/model-spinlens-v1.0/model.safetensors
# → .gitignore:35:dist/  ...
```

## 万一要重发：8 个文件从哪来

打包目录本来叫 `dist/model-spinlens-v1.0/`，**这个目录已经不在了**（清理时删的）。按下面凑齐：

| 文件 | 去哪拿 |
|---|---|
| `model.safetensors`、`tokenizer.json`、`tokenizer_config.json`、`config.json`、`apply_info.json` | 本机 `lab/train/runs/all20/best/`（**不随仓库发布**，只有作者的机器上有） |
| `LICENSE` | 仓库根目录 |
| `README.md`（model card）、`LABELS.md` | **本机已经没有源文件了**——只能从现有 Release 页面下载回来 |

凑齐后放进一个目录（比如 `dist/model-spinlens-v1.0/`），用 `gh` 一条命令挂上去：

```bash
gh release create <新的tag> \
  dist/model-spinlens-v1.0/model.safetensors \
  dist/model-spinlens-v1.0/config.json \
  dist/model-spinlens-v1.0/tokenizer.json \
  dist/model-spinlens-v1.0/tokenizer_config.json \
  dist/model-spinlens-v1.0/apply_info.json \
  dist/model-spinlens-v1.0/README.md \
  dist/model-spinlens-v1.0/LABELS.md \
  dist/model-spinlens-v1.0/LICENSE \
  --title "spinlens 模型权重" \
  --notes "<说明文字，参考现有 Release 页的写法>"
```

> ⚠️ **8 个文件都要传。** 别人拿到一个没有 `config.json` 和分词器的权重是跑不起来的。
> 不想用 `gh` 就网页上传——注意 Release 是挂在 tag 上的，得先把 tag 推上去。

## 相关

- 怎么用这些权重：见根目录 [README.md](../README.md) 的「下载模型」一节
- 模型效果与短板：[EXAMPLES.md](EXAMPLES.md)
