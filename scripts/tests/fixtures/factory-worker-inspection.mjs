export function workerInspection(imageId, name, id) {
  return {
    Id: id, Image: imageId, Name: `/${name}`,
    Config: {
      User: '10001:10001', WorkingDir: '/workspace/mellon',
      Entrypoint: ['node', '/opt/bootstrap/start.mjs'], Cmd: null,
      Labels: { 'org.mellon.factory.bootstrap': 'true' },
      Env: [
        'HOME=/home/worker', 'PI_CODING_AGENT_DIR=/worker-state/pi-agent',
        'T3CODE_HOME=/worker-state/t3', 'NODE_ENV=production',
        'NODE_VERSION=24.22.2', 'YARN_VERSION=1.22.22',
        'LD_LIBRARY_PATH=/opt/t3/lib',
        'PATH=/opt/pi/node_modules/.bin:/opt/t3:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      ],
    },
    HostConfig: {
      NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false,
      UsernsMode: '', PidMode: '', IpcMode: 'private', UTSMode: '',
      CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'],
      Memory: 4294967296, MemorySwap: 4294967296, NanoCpus: 2000000000,
      PidsLimit: 128, Init: true, Binds: null, Devices: [], DeviceRequests: null,
      PortBindings: {}, PublishAllPorts: false,
      Tmpfs: {
        '/tmp': 'rw,nosuid,nodev,noexec,size=128m,uid=10001,gid=10001,mode=1777',
        '/home/worker': 'rw,nosuid,nodev,noexec,size=64m,uid=10001,gid=10001,mode=0700',
        '/worker-state': 'rw,nosuid,nodev,noexec,size=256m,uid=10001,gid=10001,mode=0700',
        '/workspace/mellon': 'rw,nosuid,nodev,noexec,size=128m,uid=10001,gid=10001,mode=0700',
      },
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
    },
    Mounts: [], NetworkSettings: { Ports: {}, Networks: {} },
  };
}
