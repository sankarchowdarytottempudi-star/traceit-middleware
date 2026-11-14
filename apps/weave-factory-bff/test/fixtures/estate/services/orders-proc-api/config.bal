// orders-proc-api: sample process API of the test estate.
import acme/shared_commons as commons;

configurable string env = "local";
configurable int httpPort = 8081;
configurable string basePath = "/orders-proc-api/v1";
configurable string stockPath = "/stock-sys-api/v1/stock";
# Where stock levels are read from.
configurable commons:DownstreamSettings stock = {url: "http://localhost:9090"};
configurable commons:DownstreamSettings billing = {url: "https://billing.example.test", timeoutSeconds: 10};
configurable string signingSecret = "";
