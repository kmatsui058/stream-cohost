# Spec Delta

## REMOVED Requirements

### Requirement: 配信の情報が変わったら張り直す
**Reason**: 答える役への問い合わせのたびに最新の指示を組み立てるので、張り直しが要らなくなったため。
**Migration**: 配信の情報は次の問い合わせから反映される（conversation-memory の「問い合わせの材料を組み立てる」）。
