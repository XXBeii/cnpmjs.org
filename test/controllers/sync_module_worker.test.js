'use strict';

var assert = require('assert');
var awaitEvent = require('await-event');
var should = require('should');
var mm = require('mm');
var thunkify = require('thunkify-wrap');
var request = require('supertest');
var urllib = require('urllib');
var urlparse = require('url').parse;
var fs = require('mz/fs');
var config = require('../../config');
var common = require('../../lib/common');
var SyncModuleWorker = require('../../controllers/sync_module_worker');
var logService = require('../../services/module_log');
var packageService = require('../../services/package');
var utils = require('../utils');
var app = require('../../servers/registry');
var User = require('../../models').User;

describe('test/controllers/sync_module_worker.test.js', () => {
  afterEach(mm.restore);

  beforeEach(() => {
    mm(config, 'syncModel', 'all');
    mm(config, 'sourceNpmRegistryIsCNpm', false);
    mm(config, 'privatePackages', ['google']);
  });

  before(function (done) {
    mm(config, 'privatePackages', ['google']);
    var pkg = utils.getPackage('google', '0.0.1', utils.admin);
    request(app)
    .put('/' + pkg.name)
    .set('authorization', utils.adminAuth)
    .send(pkg)
    .expect(201, done);
  });

  it('should not sync local package', function* () {
    var worker = new SyncModuleWorker({
      name: 'google',
      username: 'fengmk2',
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
  });

  it('should not sync private scoped package', function* () {
    var worker = new SyncModuleWorker({
      name: '@cnpmtest/google',
      username: 'fengmk2',
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
  });

  it('should sync public scoped package', function* () {
    mm(config, 'syncMode', 'all');
    mm(config, 'registryHost', '');
    // mm(config, 'sourceNpmRegistry', 'https://registry.npmjs.org');
    let envelope;
    mm(config, 'globalHook', function* (e) {
      envelope = e;
    });

    var worker = new SyncModuleWorker({
      name: '@sindresorhus/df',
      username: 'fengmk2',
      noDep: true,
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
    assert(envelope);
    assert(envelope.event === 'package:sync');
    assert(envelope.name === '@sindresorhus/df');
    assert(envelope.payload.changedVersions.length > 0);

    // sync again
    var worker = new SyncModuleWorker({
      name: '@sindresorhus/df',
      username: 'fengmk2',
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
    assert(envelope);
    assert(envelope.event === 'package:sync');
    assert(envelope.name === '@sindresorhus/df');
    assert(envelope.payload.changedVersions.length === 0);

    var tgzUrl;
    function checkResult() {
      return function (done) {
        request(app)
        .get('/@sindresorhus/df')
        .expect(function (res) {
          var latest = res.body.versions[res.body['dist-tags']['latest']];
          tgzUrl = latest.dist.tarball;
        })
        .expect(200, done);
      };
    }

    yield checkResult();

    const p = urlparse(tgzUrl);
    var r = yield request(app).get(p.path);
    r.status.should.equal(200);
    r.headers['content-type'].should.equal('application/octet-stream');
  });

  it('should start a sync worker and dont sync deps', function* () {
    var log = yield logService.create({
      name: 'byte',
      username: 'fengmk2',
    });
    log.id.should.above(0);
    var worker = new SyncModuleWorker({
      logId: log.id,
      name: 'byte',
      username: 'fengmk2',
      noDep: true,
    });
    worker.start();
    setTimeout(function () {
      worker.add('pedding');
      worker.add('byte');
      worker.add('tair');
      worker.add('byte-not-exists');
    }, 10);
    var end = thunkify.event(worker, 'end');
    yield end();

    // sync again
    worker = new SyncModuleWorker({
      logId: log.id,
      name: 'byte',
      username: 'fengmk2',
    });
    worker.start();
    end = thunkify.event(worker, 'end');
    yield end();
  });

  it('should sync mk2test-module-cnpmsync add os, cpu success', function* () {
    mm(config, 'enableAbbreviatedMetadata', true);
    mm(config, 'sourceNpmRegistry', 'https://registry.npmjs.com');
    var log = yield logService.create({
      name: 'mk2test-module-cnpmsync',
      username: 'fengmk2',
    });
    log.id.should.above(0);
    var worker = new SyncModuleWorker({
      logId: log.id,
      name: 'mk2test-module-cnpmsync',
      username: 'fengmk2',
      noDep: true,
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();

    let pkg;
    let pkgV2;
    let pkgV3;
    let lastResHeaders;
    function checkResult() {
      return function (done) {
        request(app)
        .get('/mk2test-module-cnpmsync')
        .set('accept', 'application/vnd.npm.install-v1+json')
        .expect(function (res) {
          lastResHeaders = res.headers;
          pkg = res.body.versions['1.0.0'];
          assert(pkg.os[0] === 'linux');
          assert(pkg.cpu[0] === 'x64');
          assert(!pkg.peerDependenciesMeta);
          pkgV2 = res.body.versions['2.0.0'];
          assert(pkgV2.os[0] === 'linux');
          assert(pkgV2.cpu[0] === 'x64');
          assert(pkgV2.peerDependenciesMeta);
          pkgV3 = res.body.versions['3.0.0'];
          assert(!pkgV3.os);
          assert(!pkgV3.cpu);
          assert(pkgV3.peerDependenciesMeta);
        })
        .expect(200, done);
      };
    }
    yield checkResult();
    const oldEtag = lastResHeaders.etag;
    // check etag keep same again
    yield checkResult();
    assert(oldEtag == lastResHeaders.etag);

    // modify result
    yield packageService.updateModuleAbbreviatedPackage({
      name: pkg.name,
      version: pkg.version,
      os: undefined,
      cpu: undefined,
      peerDependenciesMeta: undefined,
    });

    yield packageService.updateModuleAbbreviatedPackage({
      name: pkgV2.name,
      version: pkgV2.version,
      os: undefined,
      cpu: undefined,
      peerDependenciesMeta: undefined,
    });
    yield packageService.updateModuleAbbreviatedPackage({
      name: pkgV3.name,
      version: pkgV3.version,
      peerDependenciesMeta: undefined,
    });

    function checkModifiyResult() {
      return function (done) {
        request(app)
        .get('/mk2test-module-cnpmsync')
        .set('accept', 'application/vnd.npm.install-v1+json')
        .expect(function (res) {
          // console.log(JSON.stringify(res.body, null, 2));
          assert(!res.body.versions['1.0.0'].os);
          assert(!res.body.versions['1.0.0'].cpu);
          assert(!res.body.versions['2.0.0'].peerDependenciesMeta);
          assert(!res.body.versions['3.0.0'].peerDependenciesMeta);
        })
        .expect(200, done);
      };
    }
    yield checkModifiyResult();

    // sync again
    worker = new SyncModuleWorker({
      logId: log.id,
      name: 'mk2test-module-cnpmsync',
      username: 'fengmk2',
      noDep: true,
    });
    worker.start();
    end = thunkify.event(worker, 'end');
    yield end();

    // check again still work
    yield checkResult();
    const newEtag = lastResHeaders.etag;
    assert(newEtag !== oldEtag);

    // check etag keep same again
    yield checkResult();
    assert(newEtag == lastResHeaders.etag);
  });

  it('should sync mk2test-module-cnpmsync-issue-1667 with remoteAbbreviatedVersion success', function* () {
    mm(config, 'enableAbbreviatedMetadata', true);
    mm(config, 'sourceNpmRegistry', 'https://registry.npmjs.com');
    var log = yield logService.create({
      name: 'mk2test-module-cnpmsync-issue-1667',
      username: 'fengmk2',
    });
    log.id.should.above(0);
    var worker = new SyncModuleWorker({
      logId: log.id,
      name: 'mk2test-module-cnpmsync-issue-1667',
      username: 'fengmk2',
      noDep: true,
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();

    let pkg;
    let pkgV2;
    let pkgV3;
    let lastResHeaders;
    function checkResult() {
      return function (done) {
        request(app)
        .get('/mk2test-module-cnpmsync-issue-1667')
        .set('accept', 'application/vnd.npm.install-v1+json')
        .expect(function (res) {
          lastResHeaders = res.headers;
          console.log('%j', res.body);
          pkg = res.body.versions['3.0.0'];
          assert(pkg.hasInstallScript === true);
          // no scripts
          assert(!pkg.scripts);
          assert(pkg.dist.key === '/mk2test-module-cnpmsync-issue-1667/-/mk2test-module-cnpmsync-issue-1667-3.0.0.tgz');
          assert(!('noattachment' in pkg.dist));
        })
        .expect(200, done);
      };
    }
    yield checkResult();

    function checkFullResult() {
      return function (done) {
        request(app)
        .get('/mk2test-module-cnpmsync-issue-1667')
        .set('accept', 'application/json')
        .expect(function (res) {
          lastResHeaders = res.headers;
          console.log('%j', res.body);
          pkg = res.body.versions['3.0.0'];
          assert(pkg.hasInstallScript === true);
          // has scripts
          assert(pkg.scripts);
          // console.log(pkg.dist);
          assert(pkg.dist.key === '/mk2test-module-cnpmsync-issue-1667/-/mk2test-module-cnpmsync-issue-1667-3.0.0.tgz');
          assert(pkg.dist.integrity === 'sha512-pwnnZyjvr29UxwFAIx7xHvVCkFpGVAYgaFllr/m5AZoD1CR2uHHPw16ISEO/A2rZ0WM3UoAghwd5bAZ4pYzD2Q==');
          assert(pkg.dist.shasum === 'c31af371a6cdc10dd5b9ad26625a4c863249198d');
          assert(pkg.dist.fileCount === 2);
          assert(pkg.dist.unpackedSize === 232);
          assert(pkg.dist.size === 271);
        })
        .expect(200, done);
      };
    }
    yield checkFullResult();
  });

  it('should sync upstream first', function* () {
    mm(config, 'sourceNpmRegistryIsCNpm', true);
    var log = yield logService.create({
      name: 'mk2testmodule',
      username: 'fengmk2',
    });
    var worker = new SyncModuleWorker({
      logId: log.id,
      name: 'mk2testmodule',
      username: 'fengmk2',
      noDep: true,
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
  });

  it('should start a sync worker with names and noDep', function (done) {
    var worker = new SyncModuleWorker({
      name: ['mk2testmodule'],
      noDep: true,
      username: 'fengmk2'
    });

    worker.start();
    worker.on('end', function () {
      var names = worker.successes.concat(worker.fails);
      names.sort();
      assert(names.length >= 1 && names.length <= 2);
      // names.should.eql(['mk2testmodule', 'mk2testmodule']);
      done();
    });
  });

  it('should start a sync worker with names', function (done) {
    var worker = new SyncModuleWorker({
      name: ['mk2testmodule'],
      username: 'fengmk2'
    });

    worker.start();
    worker.on('end', done);
  });

  it('should sync unpublished module by name', function* () {
    var result = yield SyncModuleWorker.sync('tnpm', 'fengmk2');
    result.should.be.Number();
  });

  it('should sync not exists module', function* () {
    var result = yield SyncModuleWorker.sync('tnpm-not-exists', 'fengmk2');
    result.should.be.Number();
  });

  it('should sync unpublished info', function (done) {
    var worker = new SyncModuleWorker({
      name: ['afp'],
      username: 'fengmk2'
    });

    worker.start();
    worker.on('end', function () {
      var names = worker.successes.concat(worker.fails);
      names.sort();
      names.should.eql([ 'afp' ]);
      done();
    });
  });

  it('should sync missing description, readme', function* () {
    var listModulesByName = packageService.listModulesByName;
    mm(packageService, 'listModulesByName', function* (name) {
      var mods = yield listModulesByName.call(packageService, name);
      mods.forEach(function (mod) {
        mod.description = null;
        mod.package.readme = '';
      });
      return mods;
    });

    let envelope;
    mm(config, 'globalHook', function* (e) {
      envelope = e;
      // console.log(envelope);
    });
    var worker = new SyncModuleWorker({
      name: 'pedding',
      username: 'fengmk2',
      noDep: true,
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
    assert(envelope);
    assert(envelope.name === 'pedding');
    assert(envelope.event === 'package:sync');
    assert(envelope.payload.changedVersions.length > 0);
  });

  it('should delete not exists   version', function* () {
    var listModulesByName = packageService.listModulesByName;
    mm(packageService, 'listModulesByName', function* (name) {
      var mods = yield listModulesByName.call(packageService, name);
      if (mods[0]) {
        mods[0].version = '100.0.0';
      }
      return mods;
    });

    var worker = new SyncModuleWorker({
      name: 'byte',
      username: 'fengmk2',
      noDep: true,
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
  });

  it('should not sync unpublished info on local package', function* () {
    var listModulesByName = packageService.listModulesByName;
    mm(packageService, 'listModulesByName', function* () {
      var mods = yield listModulesByName.call(packageService, 'google');
      return mods;
    });

    var worker = new SyncModuleWorker({
      name: 'tnpm',
      username: 'fengmk2',
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
  });

  it('should sync unpublished package', function* () {
    var listModulesByName = packageService.listModulesByName;
    mm(packageService, 'listModulesByName', function* () {
      var mods = yield listModulesByName.call(packageService, 'byte');
      return mods;
    });

    var worker = new SyncModuleWorker({
      name: 'tnpm',
      username: 'fengmk2',
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
  });

  it('should sync missing module abbreviateds deprecated property', function* () {
    var worker = new SyncModuleWorker({
      name: 'native-or-bluebird',
      username: 'fengmk2',
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();

    const rows = yield packageService.listModuleAbbreviatedsByName('native-or-bluebird');
    console.log('get %d rows', rows.length);
    rows.forEach(row => {
      assert(row.package.deprecated);
      // assert(row.package._hasShrinkwrap === false);
    });

    // mock deprecated missing
    mm(packageService, 'listModuleAbbreviatedsByName', function* () {
      rows.forEach((row, index) => {
        if (index % 2 === 0) {
          row.package.deprecated = 'foo + ' + row.package.deprecated;
        } else {
          row.package.deprecated = undefined;
        }
      });
      return rows;
    });

    worker = new SyncModuleWorker({
      name: 'native-or-bluebird',
      username: 'fengmk2',
    });
    worker.start();
    var end = thunkify.event(worker, 'end');
    yield end();
  });

  describe('syncUpstream()', function () {
    it('should sync upstream work', function* () {
      var worker = new SyncModuleWorker({
        name: ['tnpm'],
        username: 'fengmk2'
      });
      yield [
        worker.syncUpstream('tnpm'),
        worker.syncUpstream('pedding'),
      ];
    });
  });

  describe('sync deprecated info', () => {
    before(function* () {
      mm(config, 'syncModel', 'all');
      const worker = new SyncModuleWorker({
        name: 'pedding',
        username: 'fengmk2',
        noDep: true,
      });
      worker.start();
      const end = thunkify.event(worker, 'end');
      yield end();
    });

    it('should sync support un-deprecate action', function* () {
      const listModulesByName = packageService.listModulesByName;
      mm(packageService, 'listModulesByName', function* (name) {
        const mods = yield listModulesByName.call(packageService, name);
        mods.forEach(function (mod) {
          mod.package.deprecated = 'mock deprecated';
        });
        return mods;
      });

      var worker = new SyncModuleWorker({
        name: 'pedding',
        username: 'fengmk2',
        noDep: true,
      });
      worker.start();
      const end = thunkify.event(worker, 'end');
      yield end();
      mm.restore();
      // check deprecated
      const mods = yield packageService.listModulesByName('pedding');
      for (const mod of mods) {
        should.ok(mod.package.deprecated === undefined);
      }
    });
  });

  describe('sync user', function () {
    it('should sync fengmk2', function* () {
      var worker = new SyncModuleWorker({
        type: 'user',
        name: 'fengmk2',
        username: 'fengmk2',
      });
      worker.start();
      var end = thunkify.event(worker, 'end');
      yield end();
    });

    describe('sync deleted user', function() {
      before(function*() {
        var user = {
          name: 'notexistsuserscnpmtest',
          email: 'notexistsuserscnpmtest@gmail.com',
        };
        yield User.saveNpmUser(user);

        var user = {
          name: 'existsuserscnpmtest',
          email: 'existsuserscnpmtest@gmail.com',
          password_sha: '0',
          salt: '0',
          ip: '127.0.0.1',
        };
        yield User.add(user);
      });

      it('should not delete when cnpm user exists', function*() {
        var worker = new SyncModuleWorker({
          type: 'user',
          name: 'existsuserscnpmtest',
          username: 'fengmk2',
        });
        worker.start();
        var end = thunkify.event(worker, 'end');
        yield end();
        var user = yield User.findByName('existsuserscnpmtest');
        should.exists(user);
        user.name.should.equal('existsuserscnpmtest');
      });

      it('should delete when user exists', function*() {
        var worker = new SyncModuleWorker({
          type: 'user',
          name: 'notexistsuserscnpmtest',
          username: 'fengmk2',
        });
        worker.start();
        var end = thunkify.event(worker, 'end');
        yield end();
        var user = yield User.findByName('notexistsuserscnpmtest');
        should.not.exists(user);
      });

      it('should not delete when user not exists', function*() {
        var worker = new SyncModuleWorker({
          type: 'user',
          name: 'notexistsuserscnpmtest',
          username: 'fengmk2',
        });
        worker.start();
        var end = thunkify.event(worker, 'end');
        yield end();
        var user = yield User.findByName('notexistsuserscnpmtest');
        should.not.exists(user);
      });
    });
  });

  describe('save backup files', function () {
    const pkgName = 'backup-test';

    beforeEach(() => {
      mm(config, 'syncBackupFiles', true);
    });

    describe('package not exists', () => {
      const mockPackageJson = {
        name: pkgName,
        version: '1.0.0',
        description: 'foo',
      };

      beforeEach(() => {
        mm(packageService, 'listModulesByName', function* () {
          return [
            { name: pkgName, version: '1.0.0' },
          ];
        });
        mm(packageService, 'showPackage', function* () {
          return { package: mockPackageJson };
        });
      });

      afterEach(function* () {
        yield config.nfs.remove(common.getPackageFileCDNKey(pkgName, '1.0.0'));
      });

      it('should upload new file', function* () {
        var worker = new SyncModuleWorker({
          name: pkgName,
          username: 'fengmk2',
        });
        yield worker._saveBackupFiles();

        const cdnKey = common.getPackageFileCDNKey(pkgName, '1.0.0');
        const filePath = '/tmp/tnpm-1.0.0.json';
        yield config.nfs.download(cdnKey, filePath);
        const fileContent = yield fs.readFile(filePath, 'utf8');
        const packageJson = JSON.parse(fileContent);
        assert.deepStrictEqual(packageJson, mockPackageJson);
      });
    });

    describe('new dist tag', () => {
      beforeEach(() => {
        mm(packageService, 'listModulesByName', function* () {
          return [];
        });
        mm(packageService, 'listModuleTags', function* () {
          return [
            { tag: 'latest', version: '1.0.0' },
          ];
        });
      });

      afterEach(function* () {
        yield config.nfs.remove(common.getDistTagCDNKey(pkgName, 'latest'));
      });

      it('should create dist-tag file', function* () {
        var worker = new SyncModuleWorker({
          name: pkgName,
          username: 'fengmk2',
        });
        yield worker._saveBackupFiles();

        const cdnKey = common.getDistTagCDNKey(pkgName, 'latest');
        const filePath = '/tmp/tnpm-dist-tag.json';
        yield config.nfs.download(cdnKey, filePath);
        const fileContent = yield fs.readFile(filePath, 'utf8');
        assert(fileContent === '1.0.0');
      });
    });

    describe('remove dist tag', () => {
      beforeEach(function* () {
        mm(packageService, 'listModulesByName', function* () {
          return [];
        });
        mm(packageService, 'listModuleTags', function* () {
          return [];
        });
        const cdnKey = common.getDistTagCDNKey(pkgName, 'latest');
        const filePath = '/tmp/tnpm-dist-tag.json';
        yield fs.writeFile(filePath, '1.0.0');
        yield config.nfs.upload(filePath, {
          key: cdnKey,
        });
      });

      it('should delete', function* () {
        var worker = new SyncModuleWorker({
          name: pkgName,
          username: 'fengmk2',
        });
        yield worker._saveBackupFiles();

        const cdnKey = common.getDistTagCDNKey(pkgName, 'latest');
        let err;
        try {
          const filePath = '/tmp/tnpm-dist-tag.json';
          yield config.nfs.download(cdnKey, filePath);
        } catch (e) {
          err = e;
        }
        assert(/ENOENT/.test(err));
      });
    });

    describe('update dist tag', () => {
      beforeEach(function* () {
        mm(packageService, 'listModulesByName', function* () {
          return [];
        });
        mm(packageService, 'listModuleTags', function* () {
          return [
            { tag: 'latest', version: '1.0.1' },
          ];
        });
        const cdnKey = common.getDistTagCDNKey(pkgName, 'latest');
        const filePath = '/tmp/tnpm-dist-tag.json';
        yield fs.writeFile(filePath, '1.0.0');
        yield config.nfs.upload(filePath, {
          key: cdnKey,
        });
      });

      afterEach(function* () {
        yield config.nfs.remove(common.getDistTagCDNKey(pkgName, 'latest'));
      });

      it('should update dist-tag file', function* () {
        var worker = new SyncModuleWorker({
          name: pkgName,
          username: 'fengmk2',
        });
        yield worker._saveBackupFiles();

        const cdnKey = common.getDistTagCDNKey(pkgName, 'latest');
        const filePath = '/tmp/tnpm-dist-tag.json';
        yield config.nfs.download(cdnKey, filePath);
        const fileContent = yield fs.readFile(filePath, 'utf8');
        assert(fileContent === '1.0.1');
      });
    });

    describe('package unpublished', () => {
      it('should sync unpublished info', function* () {
        var worker = new SyncModuleWorker({
          name: ['afp'],
          username: 'fengmk2'
        });

        worker.start();
        yield awaitEvent(worker, 'end');

        const cdnKey = common.getUnpublishFileKey('afp');
        const filePath = '/tmp/unpublish-package.json';
        yield config.nfs.download(cdnKey, filePath);
        const fileContent = yield fs.readFile(filePath, 'utf8');
        assert(fileContent);
      });
    });
  });

  describe('sync from backup files', function () {
    const pkgName = 'sync-from-backup-files';
    const publishTime100 = Date.now() - 1000 * 60;
    const publishTime101 = Date.now();

    afterEach(function* () {
      try {
        yield config.nfs.remove(common.getDistTagCDNKey(pkgName, 'latest'));
        yield config.nfs.remove(common.getDistTagCDNKey(pkgName, 'beta'));
        yield config.nfs.remove(common.getPackageFileCDNKey(pkgName, '1.0.1'));
        yield config.nfs.remove(common.getPackageFileCDNKey(pkgName, '1.0.0'));
      } catch (_) {
        // ...
      }
    });

    beforeEach(function* () {
      mm(config, 'syncBackupFiles', true);

      const packageFileCDNKey100 = common.getPackageFileCDNKey(pkgName, '1.0.0');
      const packageFilePath = '/tmp/tnpm-package.json';
      yield fs.writeFile(packageFilePath, JSON.stringify({
        name: pkgName,
        version: '1.0.0',
        publish_time: publishTime100,
        description: 'mock desc',
        maintainers: [],
        author: {},
        repository: {},
        readme: 'mock readme',
        readmeFilename: 'README.md',
        homepage: 'mock home page',
        bugs: {},
        license: 'MIT',
      }));
      yield config.nfs.upload(packageFilePath, {
        key: packageFileCDNKey100,
      });

      const packageFileCDNKey101 = common.getPackageFileCDNKey(pkgName, '1.0.1');
      yield fs.writeFile(packageFilePath, JSON.stringify({
        name: pkgName,
        version: '1.0.1',
        publish_time: publishTime101,
        description: 'mock desc 101',
        maintainers: [],
        author: {},
        repository: {},
        readme: 'mock readme 101',
        readmeFilename: 'README.md',
        homepage: 'mock home page 101',
        bugs: {},
        license: 'MIT',
      }));
      yield config.nfs.upload(packageFilePath, {
        key: packageFileCDNKey101,
      });

      const distTagCDNKey = common.getDistTagCDNKey(pkgName, 'latest');
      const distTagFilePath = '/tmp/tnpm-dist-tag.json';
      yield fs.writeFile(distTagFilePath, '1.0.0');
      yield config.nfs.upload(distTagFilePath, {
        key: distTagCDNKey,
      });

      const distTagCDNKeyBeta = common.getDistTagCDNKey(pkgName, 'beta');
      yield fs.writeFile(distTagFilePath, '1.0.1');
      yield config.nfs.upload(distTagFilePath, {
        key: distTagCDNKeyBeta,
      });
    });

    it('should create pkg', function (done) {
      var worker = new SyncModuleWorker({
        name: pkgName,
        username: 'fengmk2',
        syncFromBackupFile: true,
      });
      var syncPkg;
      mm(worker, '_sync', function* (name, pkg) {
        syncPkg = pkg;
        return [ '1.0.0' ];
      })
      worker.start();
      worker.on('end', function () {
        assert.deepStrictEqual(worker.successes, [
          pkgName,
        ]);

        assert.deepStrictEqual(syncPkg, {
          name: pkgName,
          'dist-tags': { beta: '1.0.1', latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: pkgName,
              version: '1.0.0',
              publish_time: publishTime100,
              description: 'mock desc',
              maintainers: [],
              author: {},
              repository: {},
              readme: 'mock readme',
              readmeFilename: 'README.md',
              homepage: 'mock home page',
              bugs: {},
              license: 'MIT'
            },
            '1.0.1': {
              name: pkgName,
              version: '1.0.1',
              publish_time: publishTime101,
              description: 'mock desc 101',
              maintainers: [],
              author: {},
              repository: {},
              readme: 'mock readme 101',
              readmeFilename: 'README.md',
              homepage: 'mock home page 101',
              bugs: {},
              license: 'MIT'
            }
          },
          time: {
            modified: new Date(publishTime101),
            created: new Date(publishTime100),
            '1.0.0': new Date(publishTime100),
            '1.0.1': new Date(publishTime101),
          },
          description: 'mock desc 101',
          maintainers: [],
          author: {},
          repository: {},
          readme: 'mock readme 101',
          readmeFilename: 'README.md',
          homepage: 'mock home page 101',
          bugs: {},
          license: 'MIT'
        });
        done();
      });
    });

    describe('unpublish', () => {
      before(function* () {
        const filePath = '/tmp/unpublish-package.json';
        const cdnKey = common.getUnpublishFileKey('afp');
        yield fs.writeFile(filePath, JSON.stringify({
          name: 'xinglie',
          time: '2017-02-21T13:10:22.892Z',
          tags: { latest: '0.0.1' },
          maintainers:[{
            name: 'xinglie',
            email: 'kooboy_li@163.com'
          }],
          versions:["0.0.1"]
        }));
        yield config.nfs.upload(filePath, {
          key: cdnKey,
        });
      });

      it('should unpublished pkg', function* () {
        const worker = new SyncModuleWorker({
          name: ['afp'],
          username: 'fengmk2',
          syncFromBackupFile: true,
        });
        let unpublishPkg;
        mm(worker, '_unpublished', function(pkg) {
          unpublishPkg = pkg;
          return Promise.resolve();
        });

        worker.start();
        yield awaitEvent(worker, 'end');

        assert(unpublishPkg === 'afp');
      });
    });

  });
});
