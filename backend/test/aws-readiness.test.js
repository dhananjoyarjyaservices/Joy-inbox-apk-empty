"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { checkAwsDependencies } = require("../src/aws/awsReadiness");

class Command { constructor(input) { this.input = input; } }
const commands = { DescribeTableCommand: Command, HeadBucketCommand: Command };
const config = {
  tableNames: {
    messages: "JoyInboxMessages",
    customers: "JoyInboxCustomers",
    workspaces: "JoyInboxWorkspaces"
  },
  mediaBucket: "joy-inbox-media-staging"
};

test("reports healthy only when all three DynamoDB tables and S3 bucket are reachable", async () => {
  const calls = [];
  const result = await checkAwsDependencies({
    config, commands,
    dynamoClient: { send: async command => {
      calls.push(command.input.TableName);
      return { Table: { TableStatus: "ACTIVE" } };
    } },
    s3Client: { send: async command => {
      calls.push(command.input.Bucket);
      return {};
    } }
  });
  assert.equal(result.status, "ready");
  assert.equal(result.resources.length, 4);
  assert.ok(result.resources.every(item => item.status === "healthy"));
  assert.deepEqual(calls.sort(), ["JoyInboxCustomers", "JoyInboxMessages", "JoyInboxWorkspaces", "joy-inbox-media-staging"].sort());
  assert.ok(result.checkedAt);
});

test("reports attention for missing, inactive or unauthorized resources without leaking SDK errors", async () => {
  const result = await checkAwsDependencies({
    config, commands,
    dynamoClient: { send: async command => {
      if (command.input.TableName === "JoyInboxMessages") throw new Error("sensitive AWS error detail");
      return { Table: { TableStatus: "CREATING" } };
    } },
    s3Client: { send: async () => { throw new Error("AccessDenied with account details"); } }
  });
  assert.equal(result.status, "attention");
  assert.ok(result.resources.every(item => item.status !== "healthy"));
  assert.ok(!JSON.stringify(result).includes("sensitive AWS"));
  assert.ok(!JSON.stringify(result).includes("AccessDenied"));
});

test("requires configured clients and read-only command constructors", async () => {
  await assert.rejects(() => checkAwsDependencies({ config, commands, dynamoClient: {}, s3Client: {} }), /Configured AWS services/);
  await assert.rejects(() => checkAwsDependencies({ config, dynamoClient: { send() {} }, s3Client: { send() {} } }), /command constructors/);
});
