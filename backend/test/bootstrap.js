"use strict";

// Keep local and CI unit tests isolated from production subscription enforcement.
process.env.NODE_ENV = "test";
