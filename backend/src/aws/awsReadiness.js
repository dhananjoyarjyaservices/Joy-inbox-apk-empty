"use strict";

/**
 * Read-only readiness probe for the exact AWS resources configured for Joy
 * Inbox. It never creates, updates, scans or deletes customer data.
 */
async function checkAwsDependencies({ config, dynamoClient, s3Client, commands }) {
  if (!config || !dynamoClient?.send || !s3Client?.send) {
    throw new Error("Configured AWS services are required.");
  }
  if (!commands?.DescribeTableCommand || !commands?.HeadBucketCommand) {
    throw new Error("AWS readiness command constructors are required.");
  }

  const tables = Object.entries(config.tableNames);
  const results = await Promise.all(tables.map(async ([domain, tableName]) => {
    try {
      const response = await dynamoClient.send(new commands.DescribeTableCommand({ TableName: tableName }));
      const table = response.Table || {};
      return {
        resource: "dynamodb",
        domain,
        name: tableName,
        status: table.TableStatus === "ACTIVE" ? "healthy" : "attention"
      };
    } catch {
      return { resource: "dynamodb", domain, name: tableName, status: "unavailable" };
    }
  }));

  try {
    await s3Client.send(new commands.HeadBucketCommand({ Bucket: config.mediaBucket }));
    results.push({ resource: "s3", domain: "media", name: config.mediaBucket, status: "healthy" });
  } catch {
    results.push({ resource: "s3", domain: "media", name: config.mediaBucket, status: "unavailable" });
  }

  const healthy = results.every(item => item.status === "healthy");
  return Object.freeze({
    status: healthy ? "ready" : "attention",
    checkedAt: new Date().toISOString(),
    resources: results
  });
}

module.exports = { checkAwsDependencies };
