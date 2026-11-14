// Shared helpers used by every service of the sample estate.
import ballerina/http;

public type DownstreamSettings record {|
    string url;
    decimal timeoutSeconds = 30;
    boolean tlsValidation = true;
    string apiPassword = "";
|};

public isolated function newDownstreamClient(DownstreamSettings settings) returns http:Client|http:ClientError {
    http:ClientConfiguration config = {timeout: settings.timeoutSeconds};
    return new (settings.url, config);
}

public isolated function correlationIdOf(http:Request request) returns string {
    string|http:HeaderNotFoundError header = request.getHeader("correlationId");
    return header is string ? header : "generated";
}
