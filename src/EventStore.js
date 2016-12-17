const EventStream = require('./EventStream');
const uuid = require('uuid').v4;
const fs = require('fs');
const mkdirpSync = require('mkdirp').sync;
const EventEmitter = require('events');
const Storage = require('./Storage');

const ExpectedVersion = {
    Any: -1,
    EmptyStream: 0
};

class OptimisticConcurrencyError extends Error {}

/**
 * An event store optimized for working with many streams.
 * An event stream is implemented as an iterator over an index on the storage, therefore indexes need to be lightweight
 * and highly performant in read-only mode.
 */
class EventStore extends EventEmitter {

    constructor(storeName, config = {}) {
        super();
        this.streams = {};
        this.storeName = storeName || 'eventstore';
        this.storageDirectory = config.storageDirectory || './data';
        let storageConfig = Object.assign({ storageDirectory: this.storageDirectory }, config.storage);
        this.storage = new Storage(this.storeName, storageConfig);
        if (!fs.existsSync(this.storageDirectory)) {
            mkdirpSync(this.storageDirectory);
        }
        // Find existing streams by scanning dir for filenames starting with 'stream-'
        fs.readdir(this.storageDirectory, (err, files) => {
            if (err) throw err;
            let matches;
            for (let file of files) {
                if (matches = file.match(/^(stream-.*)\.index$/)) {
                    let streamName = matches[1];
                    let index = this.storage.ensureIndex(streamName);
                    this.streams[streamName] = { index };
                    this.emit('stream-available', streamName);
                }
            }
            this.emit('ready');
        });
    }

    /**
     * Close the event store and free up all resources.
     */
    close() {
        this.storage.close();
    }

    /**
     * Commit a list of events for the given stream name, which is expected to be at the given version.
     * Note that the events committed may still appear in other streams too - the given stream name is only
     * relevant for optimistic concurrency checks with the given expected version.
     *
     * @param {string} streamName The name of the stream to commit the events to.
     * @param {Array<Object>|Object} events The events to commit or a single event.
     * @param {number} [expectedVersion] One of ExpectedVersion constants or a positive version number that the stream is supposed to be at before commit.
     * @param {function} [callback] A function that will be executed when all events have been committed.
     */
    commit(streamName, events, expectedVersion = ExpectedVersion.Any, callback) {
        if (!streamName) {
            throw new Error('Must specify a stream name for commit.');
        }
        if (!events) {
            throw new Error('No events specified for commit.');
        }
        if (!(events instanceof Array)) {
            events = [events];
        }
        if (typeof expectedVersion === 'function' && typeof callback === 'undefined') {
            callback = expectedVersion;
            expectedVersion = ExpectedVersion.Any;
        }

        if (!(streamName in this.streams)) {
            this.createEventStream(streamName, { metadata: { streamName } });
        }
        if (expectedVersion !== ExpectedVersion.Any) {
            let streamVersion = this.streams[streamName].index.length;
            if (streamVersion !== expectedVersion) {
                throw new OptimisticConcurrencyError(`Optimistic Concurrency error. Expected stream "${streamName}" at version ${expectedVersion} but is at version ${streamVersion}.`);
            }
        }

        let commitId = uuid();
        let commitVersion = 0;
        for (let event of events) {
            let storedEvent = { id: uuid(), payload: event, metadata: { committedAt: Date.now(), commitVersion, commitId } };
            commitVersion++;
            this.storage.write(storedEvent, commitVersion === events.length ? callback : undefined);
        }
        this.emit('commit', commitId);
    }

    /**
     * Get an event stream for the given stream name within the revision boundaries.
     *
     * @param {string} streamName
     * @param {number} [minRevision]
     * @param {number} [maxRevision]
     * @returns {EventStream|boolean} The event stream or false if a stream with the name doesn't exist.
     */
    getEventStream(streamName, minRevision = 0, maxRevision = -1) {
        if (!(streamName in this.streams)) {
            return false;
        }
        let streamIndex = this.streams[streamName].index;
        return new EventStream(this.storage.readRange(minRevision + 1, maxRevision + 1, streamIndex));
    }

    /**
     * Create a new event stream from existing streams by joining them.
     *
     * @param {Array<string>} streamNames
     * @param {number} minRevision
     * @param {number} maxRevision
     * @return {EventStream}
     */
    fromStreams(streamNames, minRevision = 0, maxRevision = -1) {
        if (!(streamNames instanceof Array)) {
            throw new Error('Must specify an array of stream names.');
        }
        let joinStream = [];
        for (let streamName of streamNames) {
            if (!(streamName in this.streams)) {
                continue;
            }
            let streamIndex = this.streams[streamName].index;
            joinStream = joinStream.concat(streamIndex.all());
        }
        joinStream.sort((a, b) => b.number - a.number);
        if (minRevision > 0 || maxRevision > -1) {
            joinStream = joinStream.slice(minRevision, maxRevision > -1 ? maxRevision : undefined);
        }
        // TODO: Create iterator over joinStream
    }

    // EventStream = new index, but needs one stream per event type?! -> No, one stream per Projection!
    /**
     * Create a new stream with the given matcher.
     *
     * @param streamName
     * @param matcher
     * @returns {EventStream}
     */
    createEventStream(streamName, matcher) {
        if (streamName in this.streams) {
            throw new Error('Can not recreate stream!');
        }
        let streamIndexName = 'stream-' + streamName;
        let index = this.storage.ensureIndex(streamIndexName, matcher);
        if (!index) {
            throw new Error('Error creating stream index', streamName);
        }
        this.streams[streamName] = { index, matcher };
        return new EventStream(this.storage.readRange(1, 0, index));
    }

    /**
     * Delete an event stream. Will do nothing if the stream with the name doesn't exist.
     *
     * @param {string} streamName
     * @returns void
     */
    deleteEventStream(streamName) {
        if (!(streamName in this.streams)) {
            return;
        }
        this.streams[streamName].index.destroy();
        delete this.streams[streamName];
    }
}

module.exports = EventStore;
module.exports.ExpectedVersion = ExpectedVersion;
