# Spec Delta

## MODIFIED Requirements

### Requirement: 要約を確認できるようにする
システムは、要約を更新するたびに、その内容をログに記録しなければならない（SHALL）。要約だけを書き出すファイルは作ってはならない（MUST NOT）。

#### Scenario: 要約が更新された
- **WHEN** 要約が更新される
- **THEN** ログに要約の内容が記録され、要約だけを書き出すファイルは作られない
