# 历史回归测试归档

这里保存 v9.x – v10.0-rc5 时期的 `v*_test.go`。它们记录了大量当时的界面与行为约束（分页结构、灯箱层级、移动端顺序、主题标记等），可供查阅回归问题的来龙去脉。

## 注意

- **不属于当前可运行测试集**：这些文件属于旧的 `package main`，依赖已经拆分、改名或删除的内部符号，无法通过编译；`go test ./...` 不会包含本目录。
- 当前有效测试位于：
  - `app/src/internal/app/app_test.go`
  - `app/src/internal/archive/archive_test.go`
  - `app/src/internal/render/render_test.go`
  - `app/src/internal/transfer/transfer_test.go`
- 新增回归测试请直接写到对应包的 `_test.go`，不要再往本目录追加。
