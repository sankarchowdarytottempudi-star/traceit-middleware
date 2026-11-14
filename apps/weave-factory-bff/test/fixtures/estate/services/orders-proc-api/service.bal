// orders-proc-api (sample). GET an order with its stock level, create an order, cancel is not migrated.
import ballerina/http;
import ballerina/log;

import acme/shared_commons as commons;
import acme/orders_proc_api.core;

final http:Client stockClient = check commons:newDownstreamClient(stock);
final http:Client billingClient = check commons:newDownstreamClient(billing);

listener http:Listener httpListener = new (httpPort);

service /orders\-proc\-api/v1 on httpListener {

    // GET /orders/{orderId}: reads the stock level for the order.
    isolated resource function get orders/[string orderId](http:Request req) returns http:Response {
        string correlationId = commons:correlationIdOf(req);
        string|http:HeaderNotFoundError channel = req.getHeader("client_channel");
        if channel is http:HeaderNotFoundError {
            http:Response bad = new;
            bad.statusCode = 400;
            bad.setJsonPayload({message: "client_channel header is required", correlationId: correlationId});
            return bad;
        }
        http:Response|http:ClientError r = stockClient->get(stockPath + "/" + orderId, {"correlationId": correlationId, "client_channel": channel});
        if r is http:ClientError {
            log:printError("stock call failed", correlationId = correlationId, 'error = r);
            http:Response e = new;
            e.statusCode = 502;
            e.setJsonPayload({message: "Stock service was not reachable", correlationId: correlationId});
            return e;
        }
        return r;
    }

    // POST /orders: maps the request, charges it and answers with the receipt.
    isolated resource function post orders(http:Request req) returns http:Response|error {
        json body = check req.getJsonPayload();
        json charge = core:toChargeRequest(body);
        http:Response paid = check billingClient->post("/charges", charge);
        json receipt = check paid.getJsonPayload();
        http:Response ok = new;
        ok.statusCode = 201;
        ok.setJsonPayload(core:toReceipt(receipt));
        return ok;
    }

    // DELETE /orders/{orderId}: not migrated yet.
    isolated resource function delete orders/[string orderId]() returns http:Response {
        http:Response res = new;
        res.statusCode = 501;
        res.setJsonPayload({message: "Cancel order is not migrated yet"});
        return res;
    }
}

service /health on httpListener {
    isolated resource function get live() returns json => {status: "UP"};
    isolated resource function get ready() returns json => {status: "UP"};
}
