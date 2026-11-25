Synthetic Mule 4 project owned by us, written only for the Cruise Saudi Weave acceptance test.
It contains no customer source. One HTTP listener (POST /api/orders), one flow, a DataWeave
transform, and an HTTP request to a stand-in backend (POST {backend.host}:{backend.port}/orders).

Request:  {"customerName": "Test Guest", "items": [{"sku": "CS-ACC-1", "qty": 2, "unitPrice": 10.5}]}
To backend: {"customer": "TEST GUEST", "lines": [{"sku": "CS-ACC-1", "quantity": 2, "amount": 21.0}], "total": 21.0}
Answer:   {"orderId": <backend id>, "status": <backend status>, "total": 21.0}
