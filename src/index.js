var q = require('q');
var chalk = require('chalk');
var leAsymmetricEncryption = require('@castle/le-asymmetric-encryption');
var LeAsymmetricEncryptionService = new leAsymmetricEncryption.LeAsymmetricEncryptionService();
/**
 * A tool for creating and processing background jobs
 * @class JobQueueService
 * @param {StorageService} storage an instance of le-storage-service that is used to create records
 * @param {string} type the type of queue you want to create, supported types are 'default', 'session', and 'fast', leaving the field undefined is the same as 'default'
 * @returns {service}
 */
var JobQueueService = function (storage, type) {
  if (!storage) { throw new Error('Instance of storage service required'); }
  if (type !== 'session' && type !== 'fast' && type !== 'default' && type !== undefined) {
    throw new Error('Invalid value for the type param, value: ' + type);
  }
  var queueType = type;
  var _storage = storage;
  var _provider;
  var _publicKey;
  /**
   * Stores a new job to process
   * @function addJob
   * @memberof JobQueueService
   * @instance
   * @param {string} type the type of the job, used to determine how it should be processed
   * @param {string} data the data necessary to complete the job
   * @param {string} sensitiveData job data that will be encrypted before storing
   * @returns {promise} resolves with the newly created job record
   */
  this.addJob = function (type, data, sensitiveData) {
    removeUndefinedFields(data);
    removeUndefinedFields(sensitiveData);
    var _this = this;
    var promiseChain = q.resolve();
    return promiseChain.then(function () {
      if (!_publicKey && sensitiveData) {
        return _this.fetchPublicKey();
      }
    }).then(function () {
      var encryptedPayload;
      if (sensitiveData) {
        try {
          encryptedPayload = LeAsymmetricEncryptionService.encrypt(sensitiveData, _publicKey);
        } catch (err) {
          console.log(err);
        }
      }
      var record;
      if (queueType === 'fast') {
        record = _storage.createRecord('_fastQueue/task');
      } else if (queueType === 'session') {
        record = _storage.createRecord('_sessionQueue/task');
      } else {
        record = _storage.createRecord('_queue/task');
      }
      var jobData = {
        type: type,
        data: data
      };
      if (encryptedPayload) {
        jobData.encryptedData = encryptedPayload.encryptedData;
        jobData.encryptedKey = encryptedPayload.encryptedKey;
      }
      return record.update(jobData);
    }).then(function (record) {
      return record;
    });
  }
  this.fetchPublicKey = function () {
    return _storage.fetchRecord('Public Key', 'BACKGROUND_PUBLIC_KEY').then(function (publicKeyRecord) {
      var publicKeyRecordData = publicKeyRecord.getData();
      _publicKey = publicKeyRecordData.value;
    });
  }
  /**
   * Stores a new job and resolve when the job is complete
   * @function performJob
   * @memberof JobQueueService
   * @instance
   * @param {string} type the type of the job, used to determine how it should be processed
   * @param {string} data the data necessary to complete the job
   * @param {string} sensitiveData job data that will be encrypted before storing
   * @returns {promise} resolves when the task is complete
   */
  this.performJob = function (type, data, sensitiveData) {
    var deferred = q.defer();
    try {
      this.addJob(type, data, sensitiveData)
      .then(function (record) {
        record.sync(function (recordData) {
          if (recordData === null) {
            record.unsync();
            deferred.resolve();
          }
        });
      });
    } catch (err) {
      deferred.reject(err);
    }
    return deferred.promise;
  }
  /**
   * Creates a worker to process the jobs in the queue
   * @function createWorker
   * @memberof JobQueueService
   * @instance
   * @param {JobQueueProvider} provider the provider this service delegates to
   * @param {Function}  processJob function that processes the job. Called with two params `job` and `complete`. This function must call `complete()` to finish processing a job
   * @param {string}  keypair the worker's public/private key pair for decrypting incoming job data
   * @param {Object}  logService determines the correct destination for log messages
   */
  this.createWorker = function (provider, processJob, keypair, logService, dataService) {
    if (!provider) { throw new Error('Job queue provider required'); }
    if (!processJob) { throw new Error('Process job callback required'); }
    var innerProcessJob = function (job, complete) {
      var jobStartTime = new Date().getTime();
      logService.log('Processing ' + job.type + ' job', job.data);
      if (job.encryptedData) {
        try {
          var encryptedPayload = {
            encryptedData: job.encryptedData,
            encryptedKey: job.encryptedKey
          };
          var decryptedData = LeAsymmetricEncryptionService.decrypt(encryptedPayload, keypair);
          job.data = Object.assign(job.data, decryptedData);
          delete job.encryptedData;
          delete job.encryptedKey;
        } catch (err) {
          logService.error(err);
        }
      }
      processJob(job, function(){
        var jobCompleteTime = new Date().getTime();
        var jobCompletionTime = jobCompleteTime - jobStartTime;
        var trackingEvent = {
          _type: 'TrackingEvent',
          eventName: job.type + '-job-completed',
          happenedAt: new Date(),
          eventData: { jobCompletionTime: jobCompletionTime },
        }
        dataService.create(trackingEvent);
        complete();
      });
    }
    _provider = provider;
    _provider.createWorker(innerProcessJob);
  }
  /**
   * Prevents the worker from picking up new jobs and resolves once current jobs are complete
   * @function shutdown
   * @memberof JobQueueService
   * @instance
   * @returns {promise}
   */
  this.shutdown = function () {
    if (!_provider) { throw new Error('Job queue provider required'); }
    return _provider.shutdown();
  }
}

function removeUndefinedFields(data) {
  if(Array.isArray(data)) {
    for(var i = 0; i <data.length; i +=1) {
      var arrayContent = data[i];
      if(arrayContent === undefined) {
        data.splice(i);
        i -=1;
      }
    }
  }
  if(typeof data !== 'object') {
    return;
  }
  for(var key in data) {
    if(data.hasOwnProperty(key)) {
      if(typeof data[key] === 'object') {
        removeUndefinedFields(data[key]);
      }
      if(data[key] === undefined) {
        delete data[key];
      }
    }
  }
}

module.exports = JobQueueService;
