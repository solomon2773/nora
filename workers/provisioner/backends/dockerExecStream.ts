// @ts-nocheck
const { PassThrough } = require("node:stream");

function demuxDockerExecStream(docker, rawStream) {
  if (!docker?.modem?.demuxStream || !rawStream) {
    throw new Error("Docker exec stream demultiplexer is unavailable");
  }

  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stream = new PassThrough();
  let finished = false;

  const finish = () => {
    if (finished) return;
    finished = true;
    stdout.end();
    stderr.end();
    if (!stream.destroyed) stream.end();
  };
  const fail = (error) => {
    if (finished) return;
    finished = true;
    stdout.destroy();
    stderr.destroy();
    stream.destroy(error);
  };

  stdout.on("data", (chunk) => stream.write(chunk));
  stderr.on("data", (chunk) => stream.write(chunk));
  stdout.on("error", fail);
  stderr.on("error", fail);
  rawStream.once("end", finish);
  rawStream.once("close", finish);
  rawStream.once("error", fail);
  docker.modem.demuxStream(rawStream, stdout, stderr);

  const destroy = stream.destroy.bind(stream);
  stream.destroy = (...args) => {
    finished = true;
    stdout.destroy();
    stderr.destroy();
    rawStream.destroy();
    return destroy(...args);
  };

  return stream;
}

module.exports = { demuxDockerExecStream };
