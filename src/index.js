var _ = require( "lodash" );
var Monologue = require( "monologue.js" );
var when = require( "when" );
var connectionFn = require( "./connectionFsm.js" );
var topologyFn = require( "./topology.js" );
var postal = require( "postal" );
var uuid = require( "node-uuid" );
var dispatch = postal.channel( "rabbit.dispatch" );
var responses = postal.channel( "rabbit.responses" );
var signal = postal.channel( "rabbit.ack" );

var unhandledStrategies = {
	nackOnUnhandled: function( message ) {
		message.nack();
	},
	rejectOnUnhandled: function( message ) {
		message.reject();
	},
	customOnUnhandled: function() {}
};
var returnedStrategies = {
	customOnReturned: function() {}
};
unhandledStrategies.onUnhandled = unhandledStrategies.nackOnUnhandled;
returnedStrategies.onReturned = returnedStrategies.customOnReturned;

var serializers = {
	"application/json": {
		deserialize: function( bytes, encoding ) {
			return JSON.parse( bytes.toString( encoding || "utf8" ) );
		},
		serialize: function( object ) {
			return new Buffer( JSON.stringify( object ), "utf8" );
		}
	},
	"application/octet-stream": {
		deserialize: function( bytes ) {
			return bytes;
		},
		serialize: function( bytes ) {
			return bytes;
		}
	},
	"text/plain": {
		deserialize: function( bytes, encoding ) {
			return bytes.toString( encoding || "utf8" );
		},
		serialize: function( string ) {
			return new Buffer( string, "utf8" );
		}
	}
};

var Broker = function() {
	this.connections = {};
	this.hasHandles = false;
	this.autoNack = false;
	this.serializers = serializers;
	this.configurations = {};
	_.bindAll( this );
};

Broker.prototype.addConnection = function( options ) {
	var name = options ? ( options.name || "default" ) : "default";
	options = options || {};
	options.name = name;
	options.retryLimit = options.retryLimit || 3;
	options.failAfter = options.failAfter || 60;
	var connection;
	if ( !this.connections[ name ] ) {
		connection = connectionFn( options );
		var topology = topologyFn( connection, options || {}, serializers, unhandledStrategies, returnedStrategies );
		connection.on( "connected", function() {
			this.emit( "connected", connection );
			this.emit( connection.name + ".connection.opened", connection );
			this.setAckInterval( 500 );
		}.bind( this ) );
		connection.on( "closed", function() {
			this.emit( "closed", connection );
			this.emit( connection.name + ".connection.closed", connection );
		}.bind( this ) );
		connection.on( "failed", function( err ) {
			this.emit( "failed", connection );
			this.emit( name + ".connection.failed", err );
		}.bind( this ) );
		connection.on( "unreachable", function() {
			this.emit( "unreachable", connection );
			this.emit( name + ".connection.unreachable" );
			this.clearAckInterval();
		}.bind( this ) );
		connection.on( "return", function(raw) {
			this.emit( "return", raw);
		}.bind( this ) );
		this.connections[ name ] = topology;
		return topology;
	} else {
		connection = this.connections[ name ];
		connection.connection.connect();
		return connection;
	}
};

Broker.prototype.addExchange = function( name, type, options, connectionName ) {
	connectionName = connectionName || "default";
	if ( _.isObject( name ) ) {
		options = name;
		connectionName = type;
	} else {
		options.name = name;
		options.type = type;
	}
	return this.connections[ connectionName ].createExchange( options );
};

Broker.prototype.addQueue = function( name, options, connectionName ) {
	connectionName = connectionName || "default";
	options.name = name;
	if ( options.subscribe && !this.hasHandles ) {
		console.warn( "Subscription to '" + name + "' was started without any handlers. This will result in lost messages!" );
	}
	return this.connections[ connectionName ].createQueue( options, connectionName );
};

Broker.prototype.addSerializer = function( contentType, serializer ) {
	serializers[ contentType ] = serializer;
};

Broker.prototype.batchAck = function() {
	signal.publish( "ack", {} );
};

Broker.prototype.bindExchange = function( source, target, keys, connectionName ) {
	connectionName = connectionName || "default";
	return this.connections[ connectionName ].createBinding( { source: source, target: target, keys: keys } );
};

Broker.prototype.bindQueue = function( source, target, keys, connectionName ) {
	connectionName = connectionName || "default";
	return this.connections[ connectionName ].createBinding(
		{ source: source, target: target, keys: keys, queue: true },
		connectionName
	);
};

Broker.prototype.clearAckInterval = function() {
	clearInterval( this.ackIntervalId );
};

Broker.prototype.closeAll = function( reset ) {
	// COFFEE IS FOR CLOSERS
	var closers = _.map( this.connections, function( connection ) {
		return this.close( connection.name, reset );
	}.bind( this ) );
	return when.all( closers );
};

Broker.prototype.close = function( connectionName, reset ) {
	connectionName = connectionName || "default";
	var connection = this.connections[ connectionName ].connection;
	if ( !_.isUndefined( connection ) ) {
		if( reset ) {
			this.connections[ connectionName ].reset();
		}
		return connection.close( reset );
	} else {
		return when( true );
	}
};

Broker.prototype.deleteExchange = function( name, connectionName ) {
	connectionName = connectionName || "default";
	return this.connections[ connectionName ].deleteExchange( name );
};

Broker.prototype.deleteQueue = function( name, connectionName ) {
	connectionName = connectionName || "default";
	return this.connections[ connectionName ].deleteQueue( name );
};

Broker.prototype.getExchange = function( name, connectionName ) {
	connectionName = connectionName || "default";
	return this.connections[ connectionName ].channels[ "exchange:" + name ];
};

Broker.prototype.getQueue = function( name, connectionName ) {
	connectionName = connectionName || "default";
	return this.connections[ connectionName ].channels[ "queue:" + name ];
};

Broker.prototype.handle = function( messageType, handler, queueName, context ) {
	this.hasHandles = true;
	var options;
	if( _.isString( messageType ) ) {
		options = {
			type: messageType,
			queue: queueName || "*",
			context: context,
			autoNack: this.autoNack,
			handler: handler
		}
	} else {
		options = messageType;
		options.autoNack = options.autoNack === false ? false : true;
		options.queue = options.queue || (options.type ? '*' : '#');
		options.handler = options.handler || handler;
	}
	var parts = [];
	if( options.queue === "#" ) {
		parts.push( "#" );
	} else {
		parts.push( options.queue.replace( /[.]/g, "-" ) );
		if( options.type !== "" ) {
			parts.push( options.type || "#" );
		}
	}

	var target = parts.join( "." );
	var subscription = dispatch.subscribe( target, options.handler.bind( options.context ) );
	if ( options.autoNack ) {
		subscription.catch( function( err, msg ) {
			console.log( "Handler for '" + target + "' failed with:", err.stack );
			msg.nack();
		} );
	}
	subscription.remove = subscription.unsubscribe;
	return subscription;
};

Broker.prototype.ignoreHandlerErrors = function() {
	this.autoNack = false;
};

Broker.prototype.nackOnError = function() {
	this.autoNack = true;
};

Broker.prototype.nackUnhandled = function() {
	unhandledStrategies.onUnhandled = unhandledStrategies.nackOnUnhandled;
};

Broker.prototype.onUnhandled = function( handler ) {
	unhandledStrategies.onUnhandled = unhandledStrategies.customOnUnhandled = handler;
};

Broker.prototype.rejectUnhandled = function() {
	unhandledStrategies.onUnhandled = unhandledStrategies.rejectOnUnhandled;
};

Broker.prototype.onReturned = function( handler ) {
	returnedStrategies.onReturned = returnedStrategies.customOnReturned = handler;
};

Broker.prototype.publish = function( exchangeName, type, message, routingKey, correlationId, connectionName, sequenceNo ) {
	var timestamp = Date.now();
	var options;
	if ( _.isObject( type ) ) {
		options = type;
		connectionName = message || options.connectionName || "default";
	} else {
		connectionName = connectionName || message.connectionName || "default";
		options = {
			appId: this.appId,
			type: type,
			body: message,
			routingKey: routingKey,
			correlationId: correlationId,
			sequenceNo: sequenceNo,
			timestamp: timestamp,
			headers: {},
			connectionName: connectionName
		};
	}
	var connection = this.connections[ connectionName ].options;
	if( connection.publishTimeout ) {
		options.connectionPublishTimeout = connection.publishTimeout;
	}
	return this.getExchange( exchangeName, connectionName )
		.publish( options );
};

Broker.prototype.request = function( exchangeName, options, connectionName ) {
	connectionName = connectionName || options.connectionName || 'default';
	var requestId = uuid.v1();
	options.messageId = requestId;
	options.connectionName = connectionName;
	var connection = this.connections[ connectionName ].options;
	var exchange = this.getExchange( exchangeName, connectionName );
	var publishTimeout = options.timeout || exchange.publishTimeout || connection.publishTimeout || 500;
	var replyTimeout = options.replyTimeout || exchange.replyTimeout || connection.replyTimeout || ( publishTimeout * 2 );

	return when.promise( function( resolve, reject, notify ) {
		var timeout = setTimeout( function() {
			subscription.unsubscribe();
			reject( new Error( "No reply received within the configured timeout of " + replyTimeout + " ms" ) );
		}, replyTimeout );
		var subscription = responses.subscribe( requestId, function( message ) {
			if ( message.properties.headers[ "sequence_end" ] ) { // jshint ignore:line
				clearTimeout( timeout );
				resolve( message );
				subscription.unsubscribe();
			} else {
				notify( message );
			}
		} );
		this.publish( exchangeName, options );

	}.bind( this ) );
};

Broker.prototype.reset = function() {
	this.connections = {};
	this.configurations = {};
};

Broker.prototype.retry = function( connectionName ) {
	connectionName = connectionName || "default";
	var config = this.configurations[ connectionName ];
	return this.configure( config );
};

Broker.prototype.setAckInterval = function( interval ) {
	if ( this.ackIntervalId ) {
		this.clearAckInterval();
	}
	this.ackIntervalId = setInterval( this.batchAck, interval );
};

Broker.prototype.shutdown = function() {
	return this.closeAll( true )
		.then( function() {
			this.clearAckInterval();
		}.bind( this ) );
};

Broker.prototype.startSubscription = function( queueName, exclusive, connectionName ) {
	if ( !this.hasHandles ) {
		console.warn( "Subscription to '" + queueName + "' was started without any handlers. This will result in lost messages!" );
	}
	if( _.isString( exclusive ) ) {
		connectionName = exclusive;
		exclusive = false;
	}
	var queue = this.getQueue( queueName, connectionName );
	if ( queue ) {
		queue.subscribe( queue, exclusive );
		return queue;
	} else {
		throw new Error( "No queue named '" + queueName + "' for connection '" + connectionName + "'. Subscription failed." );
	}
};

Broker.prototype.stopSubscription = function( queueName, connectionName ) {
	var queue = this.getQueue( queueName, connectionName );
	if( queue ) {
		queue.unsubscribe();
		return queue;
	} else {
		throw new Error( "No queue named '" + queueName + "' for connection '" + connectionName + "'. Unsubscribe failed." );
	}
}

require( "./config.js" )( Broker );

Monologue.mixInto( Broker );

var broker = new Broker();

module.exports = broker;
