// Refrigerated Truck 4 app
"use strict";
const chalk = require('chalk');

// Use the Azure IoT device SDK for devices that connect to Azure IoT Central. 
var iotHubTransport = require('azure-iot-device-mqtt').Mqtt;
var Client = require('azure-iot-device').Client;
var Message = require('azure-iot-device').Message;
var ProvisioningTransport = require('azure-iot-provisioning-device-mqtt').Mqtt;
var SymmetricKeySecurityClient = require('azure-iot-security-symmetric-key').SymmetricKeySecurityClient;
var ProvisioningDeviceClient = require('azure-iot-provisioning-device').ProvisioningDeviceClient;
var provisioningHost = 'global.azure-devices-provisioning.net';

// Enter your Azure IoT keys.
var idScope = '0ne003B1694';
var registrationId = 'RefrigeratedTruck5';
var symmetricKey = 'uMMB9Khyiumq03Zr+YTJ0cgzEJd/ypWYNoaWqSxhwRI=';

var provisioningSecurityClient = new SymmetricKeySecurityClient(registrationId, symmetricKey);
var provisioningClient = ProvisioningDeviceClient.create(provisioningHost, idScope, new ProvisioningTransport(), provisioningSecurityClient);
var hubClient;

var truckIdentification = "Truck number 5";

var rest = require("azure-maps-rest");

// Enter your Azure Maps key.
var subscriptionKeyCredential = new rest.SubscriptionKeyCredential("36JKQoSNVb8Kb5lAPXImDk0lVmd7hJAVW66w86iMX-g");

// Azure Maps connection 
var pipeline = rest.MapsURL.newPipeline(subscriptionKeyCredential);
var routeURL = new rest.RouteURL(pipeline);

function greenMessage(text) {
    console.log(chalk.green(text) + "\n");
}
function redMessage(text) {
    console.log(chalk.red(text) + "\n");
}

// Truck globals initialized to the starting state of the truck. 
// Enums, frozen name:value pairs. 
var stateEnum = Object.freeze({ "ready": "ready", "enroute": "enroute", "delivering": "delivering", "returning": "returning", "loading": "loading", "dumping": "dumping" });
var contentsEnum = Object.freeze({ "full": "full", "melting": "melting", "empty": "empty" });
var fanEnum = Object.freeze({ "on": "on", "off": "off", "failed": "failed" });
const deliverTime = 600; // Time to complete delivery, in seconds. 
const loadingTime = 800; // Time to load contents. 
const dumpingTime = 400; // Time to dump melted contents. 
const tooWarmThreshold = 2; // Degrees C temperature that is too warm for contents. 
const tooWarmtooLong = 60; // Time in seconds for contents to start melting if temperatures are above threshold. 
var timeOnCurrentTask = 0; // Time on current task, in seconds. 
var interval = 60; // Time interval in seconds. 
var tooWarmPeriod = 0; // Time that contents are too warm, in seconds. 
var temp = -2; // Current temperature of contents, in degrees C. 
var baseLat = -36.7148099; // Base position latitude. (located in Horsham)
var baseLon = 142.2018105; // Base position longitude. 
var currentLat = baseLat; // Current position latitude. 
var currentLon = baseLon; // Current position longitude. 
var destinationLat; // Destination position latitude. 
var destinationLon; // Destination position longitude. 
var fan = fanEnum.on; // Cooling fan state. 
var contents = contentsEnum.full; // Truck contents state. 
var state = stateEnum.ready; // Truck is full and ready to go! 
var optimalTemperature = -5; // Setting - can be changed by the operator from IoT Central.
var outsideTemperature = 12; // Ambient outside temperature.
const noEvent = "none";
var eventText = noEvent; // Text to send to the IoT operator. 
var customer = [ // Latitude and longitude position of customers. 

    // Monash University 
    [-34.237980, 140.553870],

    // Melbourne University
    [-37.799500, 144.968730],

    // RMIT Melbourne
    [-37.80825935, 144.9626645442156],

    // Australian Bosnian Islamic Centre
    [-37.7478878, 144.7772157090632],

    //Chadstone Shopping Centre
    [-37.8864009, 145.08247061421372],

    //Brandon Park Shopping Centre
    [-37.904953649999996, 145.1623940025832],

    //Ballarat Wildlife Park
    [-37.569307949999995, 143.89127635215024],

    //Bendigo Art Gallery
    [-36.75734815, 144.27683511891263],

    //National Gallery of Victoria
    [-37.822610499999996, 144.968900122702],

    //KFC Bendigo
    [-36.76133765, 144.27406433000175],

    //The Mill Markets
    [-37.341962949999996, 144.13209825026223],

    //The Royal Melbourne Hospital
    [-37.79866935, 44.95641221038036],

    //Village Cinemas Geelong
    [-38.15026615, 144.3607983650906],

    //Sircuit Bar Melbourne
    [-37.805781, 144.9829357],

    //Sea Life Melbourne
    [-37.82065095, 144.95834681394763],

    //My old house (46 Honeysuckle Street, Bendigo)
    [-36.7660022, 144.2691145]
];
var path = []; // Latitude and longitude steps for the route. 
var timeOnPath = []; // Time in seconds for each section of the route. 
var truckOnSection; // The current path section the truck is on. 
var truckSectionsCompletedTime; // The time the truck has spent on previous completed sections.

//Converts degrees to radians
function Degrees2Radians(deg) {
    return deg * Math.PI / 180;
}

//converts latitude and longitude of two points to a metre distance between the two
function DistanceInMeters(lat1, lon1, lat2, lon2) {
    var dlon = Degrees2Radians(lon2 - lon1);
    var dlat = Degrees2Radians(lat2 - lat1);
    var a = (Math.sin(dlat / 2) * Math.sin(dlat / 2)) + Math.cos(Degrees2Radians(lat1)) * Math.cos(Degrees2Radians(lat2)) * (Math.sin(dlon / 2) * Math.sin(dlon / 2));
    var angle = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    var meters = angle * 6371000;
    return meters;
}

function Arrived() {

    // If the truck is within 10 meters of the destination, call it good. 
    if (DistanceInMeters(currentLat, currentLon, destinationLat, destinationLon) < 10)
    {
        return true;
    }
    return false;
}

function UpdatePosition() {
    while ((truckSectionsCompletedTime + timeOnPath[truckOnSection] < timeOnCurrentTask) && (truckOnSection < timeOnPath.length - 1)) {
        // Truck has moved on to the next section. 
        truckSectionsCompletedTime += timeOnPath[truckOnSection];
        ++truckOnSection;
    }

    // Ensure remainder is less than or equal to 1, because the interval may take count over what is needed. 
    var remainderFraction = Math.min(1, (timeOnCurrentTask - truckSectionsCompletedTime) / timeOnPath[truckOnSection]);

    // The path should be one entry longer than the timeOnPath array. 
    // Find how far along the section the truck has moved. 
    currentLat = path[truckOnSection][0] + remainderFraction * (path[truckOnSection + 1][0] - path[truckOnSection][0]);
    currentLon = path[truckOnSection][1] + remainderFraction * (path[truckOnSection + 1][1] - path[truckOnSection][1]);
}

function GetRoute(newState) {

    // Set the state to ready, until the new route arrives. 
    state = stateEnum.ready;

    // Coordinates are in longitude first. 
    var coordinates = [
        [currentLon, currentLat],
        [destinationLon, destinationLat]
    ];
    var results = routeURL.calculateRouteDirections(rest.Aborter.timeout(10000), coordinates);
    results.then(data => {
        greenMessage("Route found. Number of points = " + JSON.stringify(data.routes[0].legs[0].points.length, null, 4));

        // Clear the path. 
        path.length = 0;

        // Start with the current location. 
        path.push([currentLat, currentLon]);

        // Retrieve the route and push the points onto the array. 
        for (var n = 0; n < data.routes[0].legs[0].points.length; n++) {
            var x = data.routes[0].legs[0].points[n].latitude;
            var y = data.routes[0].legs[0].points[n].longitude;
            path.push([x, y]);
        }

        // Finish with the destination. 
        path.push([destinationLat, destinationLon]);

        // Store the path length and the time taken to calculate the average speed. 
        var meters = data.routes[0].summary.lengthInMeters;
        var seconds = data.routes[0].summary.travelTimeInSeconds;
        var pathSpeed = meters / seconds;
        var distanceApartInMeters;
        var timeForOneSection;

        // Clear the time on the path array. 
        timeOnPath.length = 0;

        // Calculate how much time is required for each section of the path. 
        for (var t = 0; t < path.length - 1; t++) {

            // Calculate the distance between the two path points, in meters. 
            distanceApartInMeters = DistanceInMeters(path[t][0], path[t][1], path[t + 1][0], path[t + 1][1]);

            // Calculate the time for each section of the path. 
            timeForOneSection = distanceApartInMeters / pathSpeed;
            timeOnPath.push(timeForOneSection);
        }
        truckOnSection = 0;
        truckSectionsCompletedTime = 0;
        timeOnCurrentTask = 0;

        // Update the state now that the route has arrived, either enroute or returning. 
        state = newState;
    }, reason => {

        // Error: The request was aborted. 
        redMessage(reason);
        eventText = "Failed to find map route";
    });
}

function CmdGoToCustomer(request, response) {

    // Pick up a variable from the request payload. 
    var num = request.payload;

    // Check for valid customer ID. 
    if (num >= 0 && num < customer.length) {
        switch (state) {
            case stateEnum.dumping:
            case stateEnum.loading:
            case stateEnum.delivering:
                eventText = "Unable to act - " + state;
                break;
            case stateEnum.ready:
            case stateEnum.enroute:
            case stateEnum.returning:
                if (contents === contentsEnum.empty) {
                    eventText = "Unable to act - empty";
                }
                else {

                    // Set new customer event only when all is good. 
                    eventText = "New customer: " + num.toString();
                    destinationLat = customer[num][0];
                    destinationLon = customer[num][1];

                    // Find route from current position to destination, and store route. 
                    GetRoute(stateEnum.enroute);
                }
                break;
        }
    }
    else {
        eventText = "Invalid customer: " + num;
    }

    // Acknowledge the command. 
    response.send(200, 'Success', function (errorMessage) {

        // Failure 
        if (errorMessage) {
            redMessage('Failed sending a CmdGoToCustomer response:\n' + errorMessage.message);
        }
    });
}

function ReturnToBase() {
    destinationLat = baseLat;
    destinationLon = baseLon;

    // Find route from current position to base, and store route. 
    GetRoute(stateEnum.returning);
}

function CmdRecall(request, response) {
    switch (state) {
        case stateEnum.ready:
        case stateEnum.loading:
        case stateEnum.dumping:
            eventText = "Already at base";
            break;
        case stateEnum.returning:
            eventText = "Already returning";
            break;
        case stateEnum.delivering:
            eventText = "Unable to recall - " + state;
            break;
        case stateEnum.enroute:
            ReturnToBase();
            break;
    }

    // Acknowledge the command. 
    response.send(200, 'Success', function (errorMessage) {

        // Failure 
        if (errorMessage) {
            redMessage('Failed sending a CmdRecall response:\n' + errorMessage.message);
        }
    });
}

function dieRoll(max) {
    return Math.random() * max;
}

function UpdateTruck() {
    if (contents == contentsEnum.empty) {

        // Turn the cooling system off, if possible, when the contents are empty. 
        if (fan == fanEnum.on) {
            fan = fanEnum.off;
        }
        temp += -2.9 + dieRoll(6);
    }
    else {

        // Contents are full or melting. 
        if (fan != fanEnum.failed) {
            if (temp < optimalTemperature - 5) {

                // Turn the cooling system off because contents are getting too cold. 
                fan = fanEnum.off;
            }
            else {
                if (temp > optimalTemperature) {

                    // Temperature is getting higher, so turn cooling system back on. 
                    fan = fanEnum.on;
                }
            }

            // Randomly fail the cooling system. 
            if (dieRoll(100) < 1) {
                fan = fanEnum.failed;
            }
        }

        // Set the contents temperature. Maintain a cooler temperature if the cooling system is on. 
        if (fan === fanEnum.on) {
            temp += -3 + dieRoll(5);
        }
        else {
            temp += -2.9 + dieRoll(6);
        }            

        // If the temperature is above a threshold, count the seconds of the duration, and melt the contents if it goes on too long. 
        if (temp >= tooWarmThreshold) {

            // Contents are warming. 
            tooWarmPeriod += interval;
            if (tooWarmPeriod >= tooWarmtooLong) {

                // Contents are melting. 
                contents = contentsEnum.melting;
            }
        }
        else {
            // Contents are cooling. 
            tooWarmPeriod = Math.max(0, tooWarmPeriod - interval);
        }
    }

    // Limit max temp to outside temperature.
    temp = Math.min(temp, outsideTemperature);


    timeOnCurrentTask += interval;
    switch (state) {
        case stateEnum.loading:
            if (timeOnCurrentTask >= loadingTime) {

                // Finished loading. 
                state = stateEnum.ready;
                contents = contentsEnum.full;
                timeOnCurrentTask = 0;

                // Repair or turn on the cooling fan. 
                fan = fanEnum.on;
                temp = -2;
            }
            break;
        case stateEnum.ready:
            timeOnCurrentTask = 0;
            break;
        case stateEnum.delivering:
            if (timeOnCurrentTask >= deliverTime) {

                // Finished delivering. 
                contents = contentsEnum.empty;
                ReturnToBase();
            }
            break;
        case stateEnum.returning:

            // Update the truck position. 
            UpdatePosition();

            // Check to see if the truck has arrived back at base. 
            if (Arrived()) {
                switch (contents) {
                    case contentsEnum.empty:
                        state = stateEnum.loading;
                        break;
                    case contentsEnum.full:
                        state = stateEnum.ready;
                        break;
                    case contentsEnum.melting:
                        state = stateEnum.dumping;
                        break;
                }
                timeOnCurrentTask = 0;
            }
            break;
        case stateEnum.enroute:

            // Update truck position. 
            UpdatePosition();

            // Check to see if the truck has arrived at the customer. 
            if (Arrived()) {
                state = stateEnum.delivering;
                timeOnCurrentTask = 0;
            }
            break;
        case stateEnum.dumping:
            if (timeOnCurrentTask >= dumpingTime) {

                // Finished dumping. 
                state = stateEnum.loading;
                contents = contentsEnum.empty;
                timeOnCurrentTask = 0;
            }
            break;
    }
}

function sendTruckTelemetry() {

    // Simulate the truck. 
    UpdateTruck();

    // Create the telemetry data JSON package. 
    var data = JSON.stringify(
        {
            // Format: 
            // Name from IoT Central app ":" variable name from NodeJS app. 
            ContentsTemperature: temp.toFixed(2),
            TruckState: state,
            CoolingSystemState: fan,
            ContentsState: contents,
            Location: {

                // Names must be lon, lat. 
                lon: currentLon,
                lat: currentLat
            },
        });

    // Add the eventText event string, if there is one. 
    if (eventText != noEvent) {
        data += JSON.stringify(
            {
                Event: eventText,
            }
        );
        eventText = noEvent;
    }

    // Create the message by using the preceding defined data. 
    var message = new Message(data);
    console.log("Message: " + data);

    // Send the message. 
    hubClient.sendEvent(message, function (errorMessage) {
        // Error 
        if (errorMessage) {
            redMessage("Failed to send message to Azure IoT Central: ${err.toString()}");
        } else {
            greenMessage("Telemetry sent");
        }
    });
}

// Send device twin reported properties. 
function sendDeviceProperties(twin, properties) {
    twin.properties.reported.update(properties, (err) => greenMessage(`Sent device properties: ${JSON.stringify(properties)}; ` +
        (err ? `error: ${err.toString()}` : `status: success`)));
}

// Add any writeable properties your device supports. Map them to a function that's called when the writeable property 
// is updated in the IoT Central application. 
var writeableProperties = {
    'OptimalTemperature': (newValue, callback) => {
        setTimeout(() => {
            optimalTemperature = newValue;
            callback(newValue, 'completed', 200);
        }, 1000);
    },
};

// Handle writeable property updates that come from IoT Central via the device twin. 
function handleWriteablePropertyUpdates(twin) {
    twin.on('properties.desired', function (desiredChange) {
        for (let setting in desiredChange) {
            if (writeableProperties[setting]) {
                greenMessage(`Received setting: ${setting}: ${desiredChange[setting]}`);
                writeableProperties[setting](desiredChange[setting], (newValue, status, code) => {
                    var patch = {
                        [setting]: {
                            value: newValue,
                            ad: status,
                            ac: code,
                            av: desiredChange.$version
                        }
                    }
                    sendDeviceProperties(twin, patch);
                });
            }
        }
    });
}

// Handle device connection to Azure IoT Central. 
var connectCallback = (err) => {
    if (err) {
        redMessage(`Device could not connect to Azure IoT Central: ${err.toString()}`);
    } else {
        greenMessage('Device successfully connected to Azure IoT Central');

        // Send telemetry to Azure IoT Central every 5 seconds. 
        setInterval(sendTruckTelemetry, 5000);

        // Get device twin from Azure IoT Central. 
        hubClient.getTwin((err, twin) => {
            if (err) {
                redMessage(`Error getting device twin: ${err.toString()}`);
            } else {

                // Send device properties once on device start up. 
                var properties =
                {
                    // Format: 
                    // <Property Name in Azure IoT Central> ":" <value in Node.js app> 
                    TruckID: truckIdentification,
                };
                sendDeviceProperties(twin, properties);
                handleWriteablePropertyUpdates(twin);
                hubClient.onDeviceMethod('GoToCustomer', CmdGoToCustomer);
                hubClient.onDeviceMethod('Recall', CmdRecall);
            }
        });
    }
};

// Start the device (register and connect to Azure IoT Central). 
provisioningClient.register((err, result) => {
    if (err) {
        redMessage('Error registering device: ' + err);
    } else {
        greenMessage('Registration succeeded');
        console.log('Assigned hub=' + result.assignedHub);
        console.log('DeviceId=' + result.deviceId);
        var connectionString = 'HostName=' + result.assignedHub + ';DeviceId=' + result.deviceId + ';SharedAccessKey=' + symmetricKey;
        hubClient = Client.fromConnectionString(connectionString, iotHubTransport);
        hubClient.open(connectCallback);
    }
});