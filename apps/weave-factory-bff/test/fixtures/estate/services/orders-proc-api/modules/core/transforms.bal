// Pure functions, one per source transformation.

# Builds the charge request sent to billing.
#
# + input - The source payload
# + return - The mapped value
public isolated function toChargeRequest(json input) returns json|error {
    return {
        orderRef: check input.id,
        amount: check input.total.value,
        currency: "EUR",
        customer: {
            email: check input.buyer.email
        }
    };
}

# Source: `receiptFlow` / Transform Message -> set-payload (DataWeave 2.0, 4 lines).
#
# + input - The source payload
# + return - The mapped value
public isolated function toReceipt(json input) returns json {
// %dw 2.0
// output application/json
// ---
// { receiptId: payload.id, paidAt: now() }
    return input;
}
