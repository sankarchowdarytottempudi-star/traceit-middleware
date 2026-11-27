# Target: Kafka (event backbone)

Kafka is the transport, not the logic. A Kafka target always pairs with a code target (Node.js / .NET) or Kafka Connect / Kafka Streams for the processing. Read the paired target file too.

## 1. What it is / artifacts
- **Topics** (name, partitions, replication, retention, cleanup policy delete/compact, configs) as IaC (Terraform/Strimzi `KafkaTopic` CRDs/scripts).
- **Schemas** in Schema Registry (Avro / JSON Schema / Protobuf), subject naming strategy, compatibility mode.
- **Producers / consumers** in the paired code target; **consumer groups**.
- **Kafka Connect** connector configs (JDBC/Debezium source, JDBC sink, SFTP/S3 connectors…) where the source unit is pure data movement.
- **Kafka Streams / ksqlDB** for stateful stream processing when the source does aggregation/joins.
- **ACLs** per principal.

## 2. Neutral → Kafka
| Neutral | Kafka |
|---|---|
| event.publish | producer send to topic with key (ordering key from the spec), schema-serialised value, headers (correlation id, event type) |
| trigger event/queue | consumer group on topic; one consumer group per unit |
| JMS queue (point-to-point) | topic + single consumer group (competing consumers) — note ordering per partition |
| JMS topic (pub/sub) | topic + one consumer group per subscriber |
| db change capture / table polling | Connect source (Debezium CDC, or JDBC source in timestamp/incrementing mode) |
| bulk load to DB | Connect JDBC sink (upsert mode with pk fields) |
| request/reply | avoid; use HTTP. If required: reply topic + correlation id, documented as deliberate |
| retry / DLQ | retry topics with back-off + DLQ topic (only where the source retried / had dead-letter) |

## 3. Triggers
Consumers start on deploy; schedules stay in the paired target (or Connect polling interval). Offset reset policy (`earliest`/`latest`) is a business decision when unspecified → open question.

## 4. Systems
Bootstrap servers, security (SASL/SSL, mTLS), Schema Registry URL — all from config. Confluent Cloud / MSK / Strimzi specifics recorded as environment, not code.

## 5. Data
- **Ordering:** per partition only → key by the entity whose order matters (e.g. hierarchy id, supplier id). Legacy "serial, in order" delivery = single partition or keyed ordering; state which.
- **Delivery:** idempotent producer on; consumers commit after successful processing (at-least-once) → consumers must be idempotent (dedup key from the spec). Exactly-once (transactions) only when the source guaranteed it.
- Schemas from the field rows; compatibility BACKWARD by default.

## 6. Error handling
none → consumer fails and stops at the offset (alert via platform) — usually not what you want; confirm · alert-then-fail → alert, do not commit, pause/stop consumer · report-and-continue → alert, publish to DLQ, commit, continue. Poison messages always go to DLQ, never infinite retry.

## 7. Config
Topic configs as code per environment; client configs from env/secrets; no credentials in repo.

## 8. Packaging / deploy / start
Apply topic/schema IaC → deploy Connect configs (REST API) → deploy consumers/producers. Start check: topics exist with declared configs, schemas registered and compatible, connectors RUNNING, consumer groups stable with assigned partitions.

## 9. Tests
Testcontainers Kafka (+ Schema Registry) integration tests: publish → consume → effect; ordering test by key; DLQ test; schema compatibility check in CI.

## 10. Target gates
Every topic in the spec declared with partitions/retention/cleanup · no topic created implicitly (auto-create off) · every message has a registered schema · each consumer unit has its own group id · DLQ exists where report-and-continue · keys defined where ordering matters.

## 11. Traps / confirm first
Partition count is hard to reduce later · compaction needs keys · consumer rebalances during long processing (max.poll.interval) · large messages (> 1 MB default) · retention vs replay needs · ordering promises from legacy JMS.

## 12. Lessons
- A legacy serial, in-order trigger (maxConcurrentThreads=1) must map to keyed ordering or a single partition — and the choice must be stated.
