var ejs = require("ejs");
var fs = require("fs");
var https = require("https");
var path = require("path");

ejs.delimiter = "\n";

var sdkGeneratorGlobals = {
    // Frequently, these are passed by reference to avoid over-use of global variables. Unfortunately, the async nature of loading api files required some global references

    // Internal note: We lowercase the argsByName-keys, targetNames, buildIdentifier, and the flags.  Case is maintained for all other argsByName-values, and targets
    argsByName: {}, // Command line args compiled into KVP's
    errorMessages: [], // String list of errors during parsing and loading steps
    targetOutputPathList: [], // A list of objects that describe sdk targets to build
    buildFlags: [], // The sdkBuildFlags which modify the list of APIs available in this build of the SDK
    apiSrcDescription: "INVALID", // Assigned if/when the api-spec source is fetched properly
    apiCache: {} // We have to pre-cache the api-spec files, because latter steps (like ejs) can't run asynchronously
};

const defaultApiSpecFilePath = "../API_Specs"; // Relative path to Generate.js
const defaultApiSpecGitHubUrl = "https://raw.githubusercontent.com/PlayFab/API_Specs/master/";
const defaultApiSpecPlayFabUrl = "https://www.playfabapi.com/apispec/";

/////////////////////////////////// The main build sequence for this program ///////////////////////////////////
function parseAndLoadApis() {
    console.log("My args:" + process.argv.join(" "));
    // Step 1
    parseCommandInputs(process.argv, sdkGeneratorGlobals.argsByName, sdkGeneratorGlobals.errorMessages, sdkGeneratorGlobals.targetOutputPathList);
    reportErrorsAndExit(sdkGeneratorGlobals.errorMessages);

    // Kick off Step 2
    loadAndCacheApis(sdkGeneratorGlobals.argsByName, sdkGeneratorGlobals.apiCache);
}

// Wrapper function for Step 3
function generateSdks() {
    generateApis(sdkGeneratorGlobals.argsByName["buildidentifier"], sdkGeneratorGlobals.targetOutputPathList, sdkGeneratorGlobals.buildFlags, sdkGeneratorGlobals.apiSrcDescription);
}

function reportErrorsAndExit(errorMessages) {
    if (errorMessages.length === 0)
        return; // No errors to report, so continue

    // Else, report all errors and exit the program
    console.log("Synatax: node generate.js\n" +
        "\t\t<targetName>=<targetOutputPath>\n" +
        "\t\t-(apiSpecPath|apiSpecGitUrl|apiSpecPfUrl)[ (<apiSpecPath>|<apiSpecGitUrl>|<apiSpecPfUrl>)]\n" +
        "\t\t[ -flags <flag>[ <flag> ...]]\n\n" +
        "\tExample: node generate.js unity-v2=../sdks/UnitySDK -apiSpecPath ../API_Specs -flags xbox playstation\n" +
        "\t\tThis builds the UnitySDK, from Specs at relative path ../API_Specs, with console APIs included\n" +
        "\t<apiSpecPath> : Directory or url containing the *.api.json files\n" +
        "\tYou must list one or more <targetName>=<targetOutputPath> arguments.\n" +
        "\tWarning, there can be no spaces in the target-specification\n");

    console.log("\nError Log:");
    for (var i = 0; i < errorMessages.length; i++)
        console.log(errorMessages[i]);

    console.log("\nPossible targetNames:");
    var targetList = getTargetsList();
    console.log("\t" + targetList.join(", "));
    process.exit(1);
}

/////////////////////////////////// Major step 1 - Parse and validate command-line inputs ///////////////////////////////////
function parseCommandInputs(args, argsByName, errorMessages, targetOutputPathList) {
    // Parse the command line arguments into key-value-pairs
    extractArgs(args, argsByName, targetOutputPathList, errorMessages);

    // Apply defaults 
    if (!argsByName.hasOwnProperty("apispecpath") && !argsByName.hasOwnProperty("apispecgiturl") && !argsByName.hasOwnProperty("apispecpfurl"))
        argsByName.apispecgiturl = ""; // If nothing is defined, default to GitHub
    // A source key set, with no value means use the default for that input format
    if (argsByName.apispecpath === "")
        argsByName.apispecpath = defaultApiSpecFilePath;
    if (argsByName.apispecgiturl === "")
        argsByName.apispecgiturl = defaultApiSpecGitHubUrl;
    if (argsByName.apispecpfurl === "")
        argsByName.apispecpfurl = defaultApiSpecPlayFabUrl;

    // Output an error if no targets are defined
    if (targetOutputPathList.length === 0)
        errorMessages.push("No targets defined, you must define at least one.");

    // Output an error if there's any problems with the api-spec source    
    var specCount = 0;
    if (argsByName.apispecpath) specCount++;
    if (argsByName.apispecgiturl) specCount++;
    if (argsByName.apispecpfurl) specCount++;
    if (specCount > 1)
        errorMessages.push("Cannot define more than one of: apiSpecPath, apiSpecGitUrl, or apiSpecPfUrl.  Pick one and remove the other(s).");

    // Parse some other values and defaults
    if (!argsByName.buildidentifier)
        argsByName.buildidentifier = "default_manual_build";
    argsByName.buildidentifier = argsByName.buildidentifier.toLowerCase(); // lowercase the buildIdentifier
    if (argsByName.hasOwnProperty("flags"))
        sdkGeneratorGlobals.buildFlags = lowercaseFlagsList(argsByName.flags.split(" "));
}

function extractArgs(args, argsByName, targetOutputPathList, errorMessages) {
    var cmdArgs = args.slice(2, args.length); // remove "node.exe generate.js"
    var activeKey = null;
    for (var i = 0; i < cmdArgs.length; i++) {
        var lcArg = cmdArgs[i].toLowerCase();
        if (cmdArgs[i].indexOf("-") === 0) {
            activeKey = lcArg.substring(1); // remove the "-", lowercase the argsByName-key
            argsByName[activeKey] = "";
        } else if (lcArg.indexOf("=") !== -1) { // any parameter with an "=" is assumed to be a target specification, lowercase the targetName
            var argPair = cmdArgs[i].split("=", 2);
            checkTarget(argPair[0].toLowerCase(), argPair[1], targetOutputPathList, errorMessages);
        } else if ((lcArg === "c:\\depot\\api_specs" || lcArg === "..\\api_specs") && activeKey === null && !argsByName.hasOwnProperty("apispecpath")) { // Special case to handle old API-Spec path as fixed 3rd parameter - DEPRECATED
            argsByName["apispecpath"] = cmdArgs[i];
        } else if (activeKey === null) {
            errorMessages.push("Unexpected token: " + cmdArgs[i]);
        } else {
            var temp = argsByName[activeKey];
            if (temp.length > 0)
                argsByName[activeKey] = argsByName[activeKey] + " " + cmdArgs[i];
            else
                argsByName[activeKey] = cmdArgs[i];
        }
    }

    // Pull from environment variables if there's no console-defined targets
    if (targetOutputPathList.length === 0 && process.env.hasOwnProperty("SdkSource") && process.env.hasOwnProperty("SdkName")) {
        checkTarget(process.env.hasOwnProperty("SdkSource"), process.env.hasOwnProperty("SdkName"), targetOutputPathList, errorMessages);
    }
}

interface ITargetOutput {
    name: string,
    dest: string,
}
function checkTarget(sdkSource, sdkDestination, targetOutputPathList, errorMessages) {
    var targetOutput: ITargetOutput = {
        name: sdkSource,
        dest: path.normalize(sdkDestination)
    };
    if (fs.existsSync(targetOutput.dest) && !fs.lstatSync(targetOutput.dest).isDirectory()) {
        errorMessages.push("Invalid target output path: " + targetOutput.dest);
    } else {
        targetOutputPathList.push(targetOutput);
    }
}

function getTargetsList() {
    var targetList = [];

    var targetsDir = path.resolve(__dirname, "targets");

    var targets = fs.readdirSync(targetsDir);
    for (var i = 0; i < targets.length; i++) {
        var target = targets[i];
        if (target[0] === ".")
            continue;

        var targetSourceDir = path.resolve(targetsDir, target);
        var targetMain = path.resolve(targetSourceDir, "make.js"); // search for make.js in each subdirectory within "targets"
        if (fs.existsSync(targetMain))
            targetList.push(target);
    }

    return targetList;
}

/////////////////////////////////// Major step 2 - Load and cache the API files ///////////////////////////////////
function loadAndCacheApis(argsByName, apiCache) {
    // generateSdks is the function that begins the next step

    if (argsByName.apispecpath) {
        loadApisFromLocalFiles(argsByName, apiCache, argsByName.apispecpath, generateSdks);
    } else if (argsByName.apispecgiturl) {
        loadApisFromGitHub(argsByName, apiCache, argsByName.apispecgiturl, generateSdks);
    } else if (argsByName.apispecpfurl) {
        loadApisFromPlayFabServer(argsByName, apiCache, argsByName.apispecpfurl, generateSdks);
    }
}

function loadApisFromLocalFiles(argsByName, apiCache, apiSpecPath, onComplete) {
    function loadEachFile(filename: string, optional: boolean) {
        var fullPath = path.resolve(apiSpecPath, filename);
        console.log("Begin reading File: " + fullPath);
        var fileContents = null;
        try {
            fileContents = require(fullPath);
        } catch (err) {
            console.log(" ***** Failed to Load: " + fullPath);
            if (!optional) throw err;
        }
        if (fileContents) {
            apiCache[filename] = fileContents;
        }
        console.log("Finished reading: " + fullPath);
    }

    loadEachFile("Admin.api.json", false);
    loadEachFile("Client.api.json", false);
    loadEachFile("Entity.api.json", true);
    loadEachFile("Matchmaker.api.json", false);
    loadEachFile("Server.api.json", false);
    loadEachFile("PlayStreamEventModels.json", false);
    loadEachFile("PlayStreamCommonEventModels.json", false);
    loadEachFile("PlayStreamProfileModels.json", false);
    loadEachFile("SdkManualNotes.json", false);

    sdkGeneratorGlobals.apiSrcDescription = argsByName.apispecpath;
    onComplete();
}

function loadApisFromGitHub(argsByName, apiCache, apiSpecGitUrl, onComplete) {
    var finishCountdown = 9;
    function onEachComplete() {
        finishCountdown -= 1;
        if (finishCountdown === 0) {
            console.log("Finished loading files from GitHub");
            sdkGeneratorGlobals.apiSrcDescription = argsByName.apiSpecGitUrl;
            onComplete();
        }
    }

    downloadFromUrl(apiSpecGitUrl, "Admin.api.json", apiCache, "Admin.api.json", onEachComplete, false);
    downloadFromUrl(apiSpecGitUrl, "Client.api.json", apiCache, "Client.api.json", onEachComplete, false);
    downloadFromUrl(apiSpecGitUrl, "Entity.api.json", apiCache, "Entity.api.json", onEachComplete, true);
    downloadFromUrl(apiSpecGitUrl, "Matchmaker.api.json", apiCache, "Matchmaker.api.json", onEachComplete, false);
    downloadFromUrl(apiSpecGitUrl, "Server.api.json", apiCache, "Server.api.json", onEachComplete, false);
    downloadFromUrl(apiSpecGitUrl, "PlayStreamEventModels.json", apiCache, "PlayStreamEventModels.json", onEachComplete, false);
    downloadFromUrl(apiSpecGitUrl, "PlayStreamCommonEventModels.json", apiCache, "PlayStreamCommonEventModels.json", onEachComplete, false);
    downloadFromUrl(apiSpecGitUrl, "PlayStreamProfileModels.json", apiCache, "PlayStreamProfileModels.json", onEachComplete, false);
    downloadFromUrl(apiSpecGitUrl, "SdkManualNotes.json", apiCache, "SdkManualNotes.json", onEachComplete, false);
}

function loadApisFromPlayFabServer(argsByName, apiCache, apiSpecPfUrl, onComplete) {
    var finishCountdown = 9;
    function onEachComplete() {
        finishCountdown -= 1;
        if (finishCountdown === 0) {
            console.log("Finished loading files from PlayFab Server");
            sdkGeneratorGlobals.apiSrcDescription = argsByName.apispecpfurl;
            onComplete();
        }
    }

    downloadFromUrl(apiSpecPfUrl, "AdminAPI", apiCache, "Admin.api.json", onEachComplete, false);
    downloadFromUrl(apiSpecPfUrl, "ClientAPI", apiCache, "Client.api.json", onEachComplete, false);
    downloadFromUrl(apiSpecPfUrl, "EntityAPI", apiCache, "Entity.api.json", onEachComplete, true);
    downloadFromUrl(apiSpecPfUrl, "MatchmakerAPI", apiCache, "Matchmaker.api.json", onEachComplete, false);
    downloadFromUrl(apiSpecPfUrl, "ServerAPI", apiCache, "Server.api.json", onEachComplete, false);
    downloadFromUrl(apiSpecPfUrl, "PlayStreamEventModels", apiCache, "PlayStreamEventModels.json", onEachComplete, false);
    downloadFromUrl(apiSpecPfUrl, "PlayStreamCommonEventModels", apiCache, "PlayStreamCommonEventModels.json", onEachComplete, false);
    downloadFromUrl(apiSpecPfUrl, "PlayStreamProfileModel", apiCache, "PlayStreamProfileModels.json", onEachComplete, false);
    // This file isn't on the pf-server, and it couldn't be accurate there either way
    downloadFromUrl(defaultApiSpecGitHubUrl, "SdkManualNotes.json", apiCache, "SdkManualNotes.json", onEachComplete, false);
}

function downloadFromUrl(srcUrl: string, appendUrl: string, apiCache, cacheKey: string, onEachComplete, optional: boolean) {
    var fullUrl = srcUrl + appendUrl;
    console.log("Begin reading URL: " + fullUrl);
    var rawResponse = "";
    https.get(fullUrl, (request) => {
        request.setEncoding("utf8");
        request.on("data", (chunk) => { rawResponse += chunk; });
        request.on("end", () => {
            console.log("Finished reading: " + fullUrl);
            try {
                apiCache[cacheKey] = JSON.parse(rawResponse);
            } catch (jsonErr) {
                console.log(" ***** Failed to parse json: " + rawResponse.trim());
                console.log(" ***** Failed to Load: " + fullUrl);
                if (!optional)
                    throw jsonErr;
            }
            onEachComplete();
        });
        request.on("error", (reqErr) => {
            console.log(" ***** Request failed on: " + fullUrl);
            console.log(reqErr);
            if (!optional)
                throw reqErr;
        });
    });
}

/////////////////////////////////// Major step 3 - Generate the indicated ouptut files ///////////////////////////////////
function generateApis(buildIdentifier, targetOutputPathList, buildFlags, apiSrcDescription) {
    console.log("Generating PlayFab APIs from specs: " + apiSrcDescription);

    var clientApis = [
        getApiDefinition("Client.api.json", buildFlags)
    ];
    var adminApis = [
        getApiDefinition("Admin.api.json", buildFlags)
    ];
    var serverApis = [
        getApiDefinition("Admin.api.json", buildFlags),
        getApiDefinition("Matchmaker.api.json", buildFlags),
        getApiDefinition("Server.api.json", buildFlags)
    ];
    var allApis = serverApis.concat(clientApis);

    var targetsDir = path.resolve(__dirname, "targets");

    for (var t = 0; t < targetOutputPathList.length; t++) {
        var target = targetOutputPathList[t];

        var sdkOutputDir = target.dest;

        console.log("Target: " + targetsDir + ", and " + target.name);
        var targetSourceDir = path.resolve(targetsDir, target.name);
        var targetMain = path.resolve(targetSourceDir, "make.js");

        console.log("Making target " + target.name + " to location " + sdkOutputDir);
        var targetMaker = require(targetMain);

        // It would probably be better to pass these into the functions, but I don't want to change all the make___Api parameters for all projects today.
        //   For now, just change the global variables in each with the data loaded from SdkManualNotes.json
        targetMaker.apiNotes = getApiJson("SdkManualNotes.json");
        targetMaker.sdkVersion = targetMaker.apiNotes.sdkVersion[target.name];
        targetMaker.buildIdentifier = buildIdentifier;
        if (targetMaker.sdkVersion === null) {
            throw "SdkManualNotes does not contain sdkVersion for " + target.name; // The point of this error is to force you to add a line to sdkManualNotes.json, to describe the version and date when this sdk/collection is built
        }

        var apiOutputDir = "";

        if (targetMaker.makeClientAPI) {
            throw "This SDK still defines makeClientAPI, instead of makeClientAPI2, meaning it will not work properly with the Entity API";
        }

        if (targetMaker.makeClientAPI2) {
            apiOutputDir = targetMaker.putInRoot ? sdkOutputDir : path.resolve(sdkOutputDir, "PlayFabClientSDK");
            console.log(" + Generating Client to " + apiOutputDir);
            if (!fs.existsSync(apiOutputDir))
                mkdirParentsSync(apiOutputDir);
            targetMaker.makeClientAPI2(clientApis, targetSourceDir, apiOutputDir);
        }

        if (targetMaker.makeServerAPI) {
            apiOutputDir = targetMaker.putInRoot ? sdkOutputDir : path.resolve(sdkOutputDir, "PlayFabServerSDK");
            console.log(" + Generating Server to " + apiOutputDir);
            if (!fs.existsSync(apiOutputDir))
                mkdirParentsSync(apiOutputDir);
            targetMaker.makeServerAPI(serverApis, targetSourceDir, apiOutputDir);
        }

        if (targetMaker.makeAdminAPI) {
            apiOutputDir = targetMaker.putInRoot ? sdkOutputDir : path.resolve(sdkOutputDir, "PlayFabServerSDK");
            console.log(" + Generating Server to " + apiOutputDir);
            if (!fs.existsSync(apiOutputDir))
                mkdirParentsSync(apiOutputDir);
            targetMaker.makeAdminAPI(adminApis, targetSourceDir, apiOutputDir);
        }

        if (targetMaker.makeCombinedAPI) {
            apiOutputDir = targetMaker.putInRoot ? sdkOutputDir : path.resolve(sdkOutputDir, "PlayFabSDK");
            console.log(" + Generating Combined to " + apiOutputDir);
            if (!fs.existsSync(apiOutputDir))
                mkdirParentsSync(apiOutputDir);
            targetMaker.makeCombinedAPI(allApis, targetSourceDir, apiOutputDir);
        }
    }

    console.log("\n\nDONE!\n");
}

function getApiDefinition(apiFileName, buildFlags) {
    var api = getApiJson(apiFileName);

    // Special case, "obsolete" is treated as an SdkGenerator flag, but is not an actual flag in pf-main
    var obsoleteFlaged = false, nonNullableFlagged = false;
    for (var b = 0; b < buildFlags.length; b++) {
        if (buildFlags[b].indexOf("obsolete") !== -1)
            obsoleteFlaged = true;
        if (buildFlags[b].indexOf("nonnullable") !== -1)
            nonNullableFlagged = true;
    }

    // Filter calls out of the API before returning it
    var filteredCalls = [];
    for (var cIdx = 0; cIdx < api.calls.length; cIdx++)
        if (isVisibleWithFlags(buildFlags, api.calls[cIdx], obsoleteFlaged, nonNullableFlagged))
            filteredCalls.push(api.calls[cIdx]);
    api.calls = filteredCalls;

    // Filter datatypes out of the API before returning it
    var filteredTypes = {};
    for (var dIdx in api.datatypes) {
        if (isVisibleWithFlags(buildFlags, api.datatypes[dIdx], obsoleteFlaged, nonNullableFlagged)) {
            var eachType = api.datatypes[dIdx];
            var filteredProperties = [];
            if (eachType.properties) {
                for (var pIdx = 0; pIdx < eachType.properties.length; pIdx++)
                    if (isVisibleWithFlags(buildFlags, eachType.properties[pIdx], obsoleteFlaged, nonNullableFlagged))
                        filteredProperties.push(eachType.properties[pIdx]);
                eachType.properties = filteredProperties;
            }
            filteredTypes[api.datatypes[dIdx].className] = eachType;
        }
    }
    api.datatypes = filteredTypes;
    return api;
}

function isVisibleWithFlags(buildFlags, apiObj, obsoleteFlaged, nonNullableFlagged) {
    // Filter obsolete elements
    if (!obsoleteFlaged && apiObj.hasOwnProperty("deprecation")) {
        var obsoleteTime = new Date(apiObj.deprecation.ObsoleteAfter);
        if (new Date() > obsoleteTime)
            return false;
    }
    // Filter governing booleans
    if (!nonNullableFlagged && apiObj.hasOwnProperty("GovernsProperty"))
        return false;

    // It's pretty easy to exclude (Api calls and datatypes)
    var exclusiveFlags = [];
    if (apiObj.hasOwnProperty("ExclusiveFlags"))
        exclusiveFlags = lowercaseFlagsList(apiObj.ExclusiveFlags);
    for (var bIdx = 0; bIdx < buildFlags.length; bIdx++)
        if (exclusiveFlags.indexOf(buildFlags[bIdx]) !== -1)
            return false;

    // All Inclusive flags must match if present (Api calls only)
    var allInclusiveFlags = [];
    if (apiObj.hasOwnProperty("AllInclusiveFlags"))
        allInclusiveFlags = lowercaseFlagsList(apiObj.AllInclusiveFlags);
    if (allInclusiveFlags.length !== 0) // If there's no flags, it is always included
        for (var alIdx = 0; alIdx < allInclusiveFlags.length; alIdx++)
            if (buildFlags.indexOf(allInclusiveFlags[alIdx]) === -1)
                return false; // If a required flag is missing, fail out

    // Any Inclusive flags must match at least one if present (Api calls and datatypes)
    var anyInclusiveFlags = [];
    if (apiObj.hasOwnProperty("AnyInclusiveFlags"))
        anyInclusiveFlags = lowercaseFlagsList(apiObj.AnyInclusiveFlags);
    if (anyInclusiveFlags.length === 0)
        return true; // If there's no flags, it is always included
    for (var anIdx = 0; anIdx < anyInclusiveFlags.length; anIdx++)
        if (buildFlags.indexOf(anyInclusiveFlags[anIdx]) !== -1)
            return true; // Otherwise at least one flag must be present
    return false;
}

/////////////////////////////////// RANDOM INTERNAL UTILITIES used locally ///////////////////////////////////

function lowercaseFlagsList(flags) {
    var output = [];
    for (var i = 0; i < flags.length; i++)
        output.push(flags[i].toLowerCase());
    return output;
}

function mkdirParentsSync(dirname) {
    if (fs.existsSync(dirname))
        return;

    var parentName = path.dirname(dirname);
    mkdirParentsSync(parentName);
    fs.mkdirSync(dirname);
}

/////////////////////////////////// GLOBAL UTILITIES used by make.js and other target-specific files ///////////////////////////////////

interface String {
    replaceAll(search: string, replacement: string): string;
    endsWith(search: string): boolean;
    contains(search: string): boolean;
    wordWrap(width: number, brk: string, cut: boolean): string;
}

// String utilities
String.prototype.replaceAll = function (search, replacement) {
    var target = this;
    return target.replace(new RegExp(search, "g"), replacement);
};

String.prototype.endsWith = function (suffix) {
    return this.indexOf(suffix, this.length - suffix.length) !== -1;
};

String.prototype.contains = function (search) {
    return this.indexOf(search) > -1;
}

/**
 * Word wraps a string to fit a particular width
 * @param width Number, default 120
 * @param brk string, inserted on wrap locations, default newline
 * @param cut boolean, default false, I think it removes everything after the wordwrap, instead of inserting brk
 * @returns {string}
 */
String.prototype.wordWrap = function (width: number, brk: string, cut: boolean): string {
    brk = brk || "\n";
    width = width || 120;
    cut = cut || false;

    var regex = '.{1,' + width + '}(\\s|$)' + (cut ? '|.{' + width + '}|.+$' : '|\\S+?(\\s|$)');
    var regres = this.match(RegExp(regex, 'g'));
    if (regres) {
        var filtered = [];
        for (var i = 0; i < regres.length; i++) {
            if (!regres[i]) continue;
            var trimmedLine = regres[i].trim();
            if (trimmedLine.length > 0)
                filtered.push(trimmedLine);
        }
        return filtered.join(brk);
    }
    return this;
};

// SDK generation utilities
function copyTree(source, dest) {
    if (!fs.existsSync(source)) {
        console.error("Copy tree source doesn't exist: " + source);
        return;
    }

    if (fs.lstatSync(source).isDirectory()) {
        if (!fs.existsSync(dest)) {
            mkdirParentsSync(dest);
        }
        else if (!fs.lstatSync(dest).isDirectory()) {
            console.error("Can't copy a directory onto a file: " + source + " " + dest);
            return;
        }


        var filesInDir = fs.readdirSync(source);
        for (var i = 0; i < filesInDir.length; i++) {
            var filename = filesInDir[i];
            var file = source + "/" + filename;
            if (fs.lstatSync(file).isDirectory()) {
                copyTree(file, dest + "/" + filename);
            }
            else {
                copyFile(file, dest);
            }
        }
    }
    else {
        copyFile(source, dest);
    }
}
global.copyTree = copyTree;

function copyFile(source, dest) {
    if (!source || !dest) {
        console.error("ERROR: Invalid copy file parameters: " + source + " " + dest);
        return;
    }

    if (!fs.existsSync(source)) {
        console.error("ERROR: copyFile source doesn't exist: " + source);
        return;
    }
    var sourceStat = fs.lstatSync(source);

    if (sourceStat.isDirectory()) {
        console.error("ERROR: copyFile source is a directory: " + source);
        return;
    }

    var filename = path.basename(source);

    if (fs.existsSync(dest)) {
        if (fs.lstatSync(dest).isDirectory()) {
            dest += "/" + filename;
        }
    }
    else {
        if (dest[dest.length - 1] === "/" || dest[dest.length - 1] === "\\") {
            mkdirParentsSync(dest);
            dest += filename;
        }
        else {
            var dirname = path.dirname(dest);
            mkdirParentsSync(dirname);
        }
    }

    if (fs.existsSync(dest)) {
        // TODO: Make this an optional flag
        //if(fs.lstatSync(dest).mtime.getTime() >= sourceStat.mtime.getTime())
        //{
        //    return;
        //}
    }

    var bufLength = 64 * 1024;
    var buff = new Buffer(bufLength);

    var fdr = fs.openSync(source, "r");
    var fdw = fs.openSync(dest, "w");
    var bytesRead = 1;
    var pos = 0;
    while (bytesRead > 0) {
        bytesRead = fs.readSync(fdr, buff, 0, bufLength, pos);
        fs.writeSync(fdw, buff, 0, bytesRead);
        pos += bytesRead;
    }
    fs.closeSync(fdr);
    fs.closeSync(fdw);
}
global.copyFile = copyFile;

// Returns one of: Null, "Proposed", "Deprecated", "Obsolete"
function getDeprecationStatus(apiObj) {
    var deprecation = apiObj.hasOwnProperty("deprecation");
    if (!deprecation)
        return null;

    var deprecationTime = new Date(apiObj.deprecation.DeprecatedAfter);
    var obsoleteTime = new Date(apiObj.deprecation.ObsoleteAfter);
    if (new Date() > obsoleteTime)
        return "Obsolete";
    if (new Date() > deprecationTime)
        return "Deprecated";
    return "Proposed";
}
global.getDeprecationStatus = getDeprecationStatus;

function readFile(filename) {
    return fs.readFileSync(filename, "utf8");
}
global.readFile = readFile;

function writeFile(filename, data) {
    var dirname = path.dirname(filename);
    if (!fs.existsSync(dirname))
        mkdirParentsSync(dirname);

    return fs.writeFileSync(filename, data);
}
global.writeFile = writeFile;

// Fetch the object parsed from an api-file, from the cache (can't load synchronously from URL-options, so we have to pre-cache them)
function getApiJson(apiFileName: string) {
    return sdkGeneratorGlobals.apiCache[apiFileName];
}
global.getApiJson = getApiJson;

/**
 * Wrapper function for boilerplate of compiling templates
 * Also Caches the Templates to avoid reloading and recompiling
 * */
function getCompiledTemplate(templatePath: string): any {
    if (!this.compiledTemplates)
        this.compiledTemplates = {};
    if (!this.compiledTemplates.hasOwnProperty(templatePath))
        this.compiledTemplates[templatePath] = ejs.compile(readFile(templatePath));
    return this.compiledTemplates[templatePath];
}
global.getCompiledTemplate = getCompiledTemplate;

/**
 * Generate the summary of an API element in a consistent way
 * TODO: Each usage of this function has a NEARLY copy-paste block of lines, joining it with language specfic comment-tags.
 *       We should merge those into this function
 * */
function generateApiSummaryLines(apiElement: any, summaryParam: string, extraLines: Array<string>, linkToDocs: boolean, deprecationLabel: string): Array<string> {
    var fullSummary;
    if (!apiElement.hasOwnProperty(summaryParam))
        fullSummary = [""];
    else if (!Array.isArray(apiElement[summaryParam]))
        fullSummary = [apiElement[summaryParam]];
    else
        fullSummary = apiElement[summaryParam];

    var lines;
    var joinedSummary = fullSummary.join(" ");
    var wrappedSummary = joinedSummary.wordWrap();
    if (wrappedSummary && wrappedSummary.length > 0)
        lines = wrappedSummary.split("\n");
    else
        lines = [];

    // Add extra documentation lines about deprecation
    if (deprecationLabel && apiElement.hasOwnProperty("deprecation")) {
        if (apiElement.deprecation.ReplacedBy != null)
            lines.push(deprecationLabel + " Please use " + apiElement.deprecation.ReplacedBy + " instead.");
        else
            lines.push(deprecationLabel + " Do not use");
    }

    // Add extra documentation lines linking to PlayFab documentation
    if (linkToDocs && apiElement.hasOwnProperty("url")) {
        var apiName = apiElement.url.split("/")[1];
        lines.push("API Method Documentation: https://api.playfab.com/Documentation/" + apiName + "/method/" + apiElement.name);
        if (apiElement.hasOwnProperty("request"))
            lines.push("Request Documentation: https://api.playfab.com/Documentation/" + apiName + "/datatype/PlayFab." + apiName + ".Models/PlayFab." + apiName + ".Models." + apiElement.request);
        if (apiElement.hasOwnProperty("result"))
            lines.push("Result Documentation: https://api.playfab.com/Documentation/" + apiName + "/datatype/PlayFab." + apiName + ".Models/PlayFab." + apiName + ".Models." + apiElement.result);
    }

    // Add explicit extra lines
    if (extraLines && Array.isArray(extraLines))
        for (var i = 0; i < extraLines.length; i++)
            lines.push(extraLines[i]);
    else if (extraLines && extraLines.length > 0)
        lines.push(extraLines);

    return lines;
}
global.generateApiSummaryLines = generateApiSummaryLines;

// Kick everything off
parseAndLoadApis();