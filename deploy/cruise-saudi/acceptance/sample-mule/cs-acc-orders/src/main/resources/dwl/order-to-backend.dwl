%dw 2.0
output application/json
var lines = (payload.items default []) map (item) -> {
  sku: item.sku,
  quantity: item.qty as Number,
  amount: (item.qty as Number) * (item.unitPrice as Number)
}
---
{
  customer: upper(payload.customerName default ""),
  lines: lines,
  total: sum(lines.amount default [0])
}
