# @typo/y-vscode

将 VS Code 原生 `TextDocument` 与已有 `Y.Text` 绑定，正文编辑无需保存即可同步。传输和存储由调用方负责，本项目复用 `@typo/client` 的协作会话。

```ts
import { VscodeBinding } from '@typo/y-vscode';

const binding = new VscodeBinding(
  session.text,
  document,
  console.error,
  initialState,
);
// 关闭文档前：await binding.flush(); binding.dispose();
```

`initialState` 是文件系统读取正文时的 `Y.encodeStateAsUpdate` 快照。绑定根据这份状态初始化编辑器副本，再补齐读取与编辑器打开之间到达的更新。

参考 [y-monaco](https://github.com/yjs/y-monaco/blob/master/src/y-monaco.js) 的双向增量绑定思路：本地 `contentChanges` 按旧文档 offset 从后向前写入 Y.Text，远端 Y.Text delta 转换为局部 TextEdit。VS Code 对局部编辑自动映射光标与选区，不进行整篇替换。

VS Code 的编辑接口跨扩展宿主异步执行，不能直接复用 Monaco 的同步互斥锁。绑定因此维护一份精确对应编辑器版本的 shadow Y.Doc：

1. 本地编辑同步写入 shadow，并将 Yjs update 合并到共享文档。
2. 远端更新先在候选副本上生成增量，通过 WorkspaceEdit 提交。
3. 提交期间缓存编辑器事件。确认成功后接收远端事件，再处理随后发生的本地输入；若版本过期被拒绝，则先合并本地输入，重新计算远端增量。
4. 由 transaction origin 区分本地/远端，防止回传。单独的 Y.UndoManager 只追踪当前绑定的本地 origin，避免撤销其他客户端的更新。

WorkspaceEdit 的版本校验参考 [VS Code 的扩展宿主实现](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/api/common/extHostBulkEdits.ts)。纯绑定核心导出在 `@typo/y-vscode/binding`，通过 EditorAdapter 接口测试异步竞态，不需要模拟整个 vscode 模块。

目前只支持顶层命名的纯文本 Y.Text（默认 `content`）。不包含 awareness、远端成员光标或磁盘离线缓存。扩展的键盘撤销/重做使用协作命令；正文会显示 VS Code 的 dirty 标记，但实时同步不依赖保存。
