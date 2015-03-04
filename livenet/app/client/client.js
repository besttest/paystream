'use strict';

angular.module('streamium.client.service', [])

.service('StreamiumClient', function(bitcore, channel, Insight, events, inherits, Duration) {
  var Consumer = channel.Consumer;

  var SECONDS_IN_MINUTE = 60;
  var MILLIS_IN_SECOND = 1000;
  var MILLIS_IN_MINUTE = MILLIS_IN_SECOND * SECONDS_IN_MINUTE;
  var TIMESTEP = 10 * MILLIS_IN_SECOND;

  function StreamiumClient() {
    this.network = bitcore.Networks.testnet;
    bitcore.Networks.defaultNetwork = bitcore.Networks.testnet;

    this.rate = this.providerKey = null;
    this.peer = this.connection = null;

    this.config = config.peerJS;
    events.EventEmitter.call(this);
  }
  inherits(StreamiumClient, events.EventEmitter);

  StreamiumClient.STATUS = {
    disconnected: 'disconnected',
    connecting: 'connecting',
    funding: 'funding',
    ready: 'ready',
    waiting: 'waiting',
    finished: 'finished'
  };

  StreamiumClient.prototype.connect = function(streamId, callback) {
    this.peer = new Peer(null, this.config);
    this.status = StreamiumClient.STATUS.connecting;
    this.fundingCallback = callback;

    var self = this;
    this.peer.on('open', function onOpen(connection) {
      console.log('Connected to peer server:', self.peer);

      self.connection = self.peer.connect(streamId);
      self.connection.on('open', function() {
        self.connection.send({
          type: 'hello',
          payload: ''
        });

        self.connection.on('data', function(data) {
          console.log('New message:', data);
          if (!data.type || !self.handlers[data.type]) throw 'Kernel panic'; // TODO!
          self.handlers[data.type].call(self, data.payload);
        });
      });
    });

    this.peer.on('close', function onClose() {
      console.log('Provider connection closed');
      self.status = StreamiumProvider.STATUS.finished;
      self.end();
    });

    this.peer.on('error', function onError(error) {
      console.log('Error with provider connection', error);
      self.status = StreamiumClient.STATUS.disconnected;
      callback(error);
    });
  };

  StreamiumClient.prototype.handlers = {};

  StreamiumClient.prototype.handlers.hello = function(data) {

    if (this.status !== StreamiumClient.STATUS.connecting) {
      console.log('Error: Received `hello` when status is ', this.status, ':', data);
      return;
    }

    if (!('rate' in data && 'publicKey' in data && 'paymentAddress' in data)) {
      console.log('Error: Malformed data payload in hello handler:', data);
      return;
    }

    this.rate = data.rate;
    this.stepSatoshis = Math.round(
      TIMESTEP * bitcore.Unit.fromBTC(this.rate).toSatoshis() / MILLIS_IN_MINUTE
    );

    this.providerKey = data.publicKey;
    this.providerAddress = new bitcore.Address(data.paymentAddress);
    this.status = StreamiumClient.STATUS.funding;

    this.consumer = new Consumer({
      network: this.network,
      providerPublicKey: this.providerKey,
      providerAddress: this.providerAddress,
      refundAddress: this.refundAddress
    });

    this.fundingCallback(null, this.consumer.fundingAddress.toString());
    this.fundingCallback = null;
  };

  StreamiumClient.prototype.processFunding = function(utxos) {
    this.consumer.processFunding(utxos);
  };

  StreamiumClient.prototype.handlers.refundAck = function(data) {

    if (this.status !== StreamiumClient.STATUS.waiting) {
      console.log('Error: received refundAck message when status is: ', this.status);
      return;
    }

    var self = this;
    data = JSON.parse(data);
    this.consumer.validateRefund(data);
    this.status = StreamiumClient.STATUS.ready;

    Insight.broadcast(this.consumer.commitmentTx, function(err) {
      self.emit('commitmentBroadcast');
      if (err) {
        console.log('Impossibe to broadcast to insight');
        return;
      }
      self.startPaying();
      self.emit('commitmentBroadcast');
    });
  };

  StreamiumClient.prototype.getDuration = function(satoshis) {
    return Duration.for(this.rate, satoshis);
  };

  StreamiumClient.prototype.getExpirationDate = function() {
    return new Date(this.startTime + this.getDuration(this.consumer.refundTx._outputAmount));
  };

  StreamiumClient.prototype.startPaying = function() {
    var self = this;
    var satoshis = 2 * this.stepSatoshis;
    this.startTime = new Date().getTime();

    this.sendCommitment();
    this.interval = setInterval(function() {
      self.updatePayment();
    }, TIMESTEP);
    console.log('Interval is ', this.interval);

    this.consumer.incrementPaymentBy(satoshis);
    this.sendPayment();
  };

  StreamiumClient.prototype.updatePayment = function() {
    this.consumer.incrementPaymentBy(this.stepSatoshis);
    this.sendPayment();
  };

  StreamiumClient.prototype.sendPayment = function() {

    if (this.status !== StreamiumClient.STATUS.ready) {
      console.log('Error: not ready to pay! Status is: ', this.status);
      return;
    }

    this.connection.send({
      type: 'payment',
      payload: this.consumer.paymentTx.toJSON()
    });
    this.emit('paymentUpdate');
  };

  StreamiumClient.prototype.sendCommitment = function() {
    this.connection.send({
      type: 'commitment',
      payload: this.consumer.commitmentTx.toJSON()
    });
  };

  StreamiumClient.prototype.handlers.paymentAck = function(data) {
    // TODO: Pass
  };

  StreamiumClient.prototype.handlers.end = function(data) {
    console.log('ending');
    this.end();
  };

  StreamiumClient.prototype.isReady = function() {
    return !!this.consumer;
  };

  StreamiumClient.prototype.askForRefund = function() {

    if (this.status !== StreamiumClient.STATUS.funding) {
      console.log('Error: trying to ask for refund tx when status is: ', this.status);
      return;
    }

    bitcore.util.preconditions.checkState(
      this.consumer.commitmentTx._inputAmount,
      'Transaction is not funded'
    );

    this.status = StreamiumClient.STATUS.waiting;
    this.consumer.commitmentTx._updateChangeOutput();
    var payload = this.consumer.setupRefund().toJSON();
    this.connection.send({
      type: 'sign',
      payload: payload
    });
  };

  StreamiumClient.prototype.end = function() {
    console.log('clearing interval ' + this.interval);
    clearInterval(this.interval);
    self.status = StreamiumClient.STATUS.finished;
    this.connection.send({
      type: 'end',
      payload: this.consumer.paymentTx.toJSON()
    });
    this.emit('end');
  };

  return new StreamiumClient();
});
