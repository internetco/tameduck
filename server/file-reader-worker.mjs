import { parentPort, workerData } from "node:worker_threads";
import { readForAI } from "./file-reader.mjs";

const { upload, buffer, format, offset } = workerData;
parentPort.postMessage(readForAI(upload, Buffer.from(buffer), format, offset));
