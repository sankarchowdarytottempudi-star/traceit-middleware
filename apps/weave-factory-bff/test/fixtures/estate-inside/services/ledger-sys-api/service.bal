// ledger-sys-api (sample): the connections are opened inside a class and inside functions,
// so there is no module-level client to read. Only their settings are declared.
import ballerina/http;
import ballerinax/postgresql;
import ballerinax/redis;

type DatabaseSettings record {|
    string host = "";
    int port = 5432;
    string name = "";
|};
type AccountSettings record {|
    string username = "";
    string password = "";
|};
type DownstreamSettings record {|
    string url;
    decimal timeoutSeconds = 30;
|};
type RedisSettings record {|
    boolean enabled = false;
    string host = "";
    int port = 6379;
    string password = "";
|};
type QueueSettings record {|
    boolean enabled = false;
    string brokerUrl = "";
    string topic = "";
|};
type PageSettings record {|
    int size = 50;
|};

configurable int httpPort = 8083;
configurable string basePath = "/ledger-sys-api/v1";
configurable DatabaseSettings database = {};
configurable AccountSettings books = {};
configurable AccountSettings audit = {};
configurable AccountSettings portalLogin = {};
configurable DownstreamSettings ratesApi = ?;
configurable DownstreamSettings unusedApi = ?;
configurable RedisSettings stateRedis = {};
configurable QueueSettings queue = {};
configurable PageSettings page = {};

isolated class Pool {
    private postgresql:Client? db = ();
    private final string account;

    isolated function init(string account) {
        self.account = account;
    }

    isolated function clientOf() returns postgresql:Client|error {
        lock {
            postgresql:Client? open = self.db;
            if open is postgresql:Client {
                return open;
            }
            AccountSettings who = self.account == "audit" ? audit : books;
            postgresql:Client made = check new (database.host, who.username, who.password, database.name, database.port);
            self.db = made;
            return made;
        }
    }
}

final Pool booksPool = new ("books");

isolated function rates() returns json|error {
    http:Client c = check new (ratesApi.url, {timeout: ratesApi.timeoutSeconds});
    return c->get("/rates");
}

isolated function remember(string key) returns error? {
    if !stateRedis.enabled {
        return;
    }
    redis:Client r = check new ({connection: {host: stateRedis.host, port: stateRedis.port, password: stateRedis.password}});
    _ = check r->set(key, "seen");
}

function startQueue() returns string => queue.enabled ? queue.brokerUrl : "off";

listener http:Listener httpListener = new (httpPort);

service /health on httpListener {
    isolated resource function get live() returns json => {status: "UP"};
}

service /ledger\-sys\-api/v1 on httpListener {
    isolated resource function get entries(int size = page.size) returns json|error {
        postgresql:Client db = check booksPool.clientOf();
        _ = check db->queryRow(`SELECT count(*) FROM entries`);
        check remember("entries");
        return {rates: check rates(), size};
    }

    isolated resource function get queue() returns json => {queue: queue.enabled};
}
