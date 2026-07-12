// @ts-nocheck
const mockBackendFor = jest.fn();

jest.mock("../containerManager", () => ({
  backendFor: (...args) => mockBackendFor(...args),
}));

const { resolveHermesDockerContainer } = require("../agentMigrations");

beforeEach(() => {
  mockBackendFor.mockReset();
});

it("uses the selected backend Docker client for Remote Docker Hermes capture", async () => {
  const container = { id: "remote-hermes-1" };
  const getContainer = jest.fn().mockReturnValue(container);
  mockBackendFor.mockResolvedValue({ docker: { getContainer } });
  const agent = {
    container_id: "remote-hermes-1",
    runtime_family: "hermes",
    deploy_target: "remote-docker",
    execution_target_id: "remote:build-host",
  };

  await expect(resolveHermesDockerContainer(agent)).resolves.toBe(container);
  expect(mockBackendFor).toHaveBeenCalledWith(agent);
  expect(getContainer).toHaveBeenCalledWith("remote-hermes-1");
});

it("fails explicitly when the selected backend cannot provide a Docker archive", async () => {
  mockBackendFor.mockResolvedValue({});

  await expect(
    resolveHermesDockerContainer({
      container_id: "hermes-k8s-1",
      runtime_family: "hermes",
      deploy_target: "k8s",
    }),
  ).rejects.toMatchObject({ code: "MIGRATION_CAPTURE_UNSUPPORTED", statusCode: 409 });
});
