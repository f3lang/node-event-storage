const expect = require('expect.js');
const fs = require('fs-extra');
const Storage = require('../src/Storage');
const Consumer = require('../src/Consumer');

const dataDir = __dirname + '/data';

describe('Consumer', function() {

    let consumer, storage;

    beforeEach(function () {
        fs.emptyDirSync(dataDir);
        storage = new Storage({ dataDirectory: dataDir });
        storage.ensureIndex('foobar', (doc) => doc.type === 'Foobar');
        consumer = new Consumer(storage, 'foobar', 'consumer1');
    });

    afterEach(function () {
        if (storage) storage.close();
        storage = undefined;
        consumer = undefined;
    });

    it('emits event when catching up', function(done){
        consumer.stop();
        storage.write({ type: 'Foobar', id: 1 });
        consumer.on('caught-up', () => {
            expect(consumer.position).to.be(1);
            done();
        });
        consumer.start();
    });

    it('receives new documents as they are added', function(done){
        let expected = 0;
        consumer.on('data', document => {
            expect(document.id).to.be(++expected);
            if (document.id === 3) {
                done();
            }
        });
        storage.write({ type: 'Foobar', id: 1 });
        storage.write({ type: 'Foobar', id: 2 });
        storage.write({ type: 'Foobar', id: 3 });
    });

    it('continues from last position after restart', function(done){
        let expected = 0;
        consumer.on('data', document => {
            expect(document.id).to.be(++expected);
            if (document.id === 3) {
                consumer.stop();
                storage.write({ type: 'Foobar', id: 4 });
                storage.write({ type: 'Foobar', id: 5 }, () => {
                    expect(consumer.position).to.be(3);
                    consumer.start();
                });
            }
            if (document.id === 5) {
                done();
            }
        });
        storage.write({ type: 'Foobar', id: 1 });
        storage.write({ type: 'Foobar', id: 2 });
        storage.write({ type: 'Foobar', id: 3 });
    });

    it('will automatically start consuming when registering data listener', function(done){
        let expected = 0;
        consumer.stop();
        storage.write({ type: 'Foobar', id: 1 });
        storage.write({ type: 'Foobar', id: 2 });
        storage.write({ type: 'Foobar', id: 3 }, () => {
            expect(consumer.position).to.be(0);

            consumer.on('data', document => {
                expect(document.id).to.be(++expected);
                if (document.id === 3) {
                    done();
                }
            });
        });
    });

    it('starting manually is no-op after registering data listener', function(done){
        let expected = 0;
        consumer.on('data', document => {
            expect(document.id).to.be(++expected);
            if (document.id === 3) {
                done();
            }
        });
        consumer.start();
        storage.write({ type: 'Foobar', id: 1 });
        storage.write({ type: 'Foobar', id: 2 });
        storage.write({ type: 'Foobar', id: 3 });
    });

});