// stock-sys-api (sample): health checks only, the business operations were never generated.
import ballerina/http;

configurable int httpPort = 8082;
configurable string basePath = "/stock-sys-api/v1";

listener http:Listener httpListener = new (httpPort);

service /health on httpListener {
    isolated resource function get live() returns json => {status: "UP"};
    isolated resource function get ready() returns json => {status: "UP"};
}
