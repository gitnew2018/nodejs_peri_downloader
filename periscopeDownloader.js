'use strict';
const fs = require('fs'),
    url = require('url'),
    https = require('https');

var link = process.argv[2];

if (link !== undefined) {
    periscope_vod_downloader(link);
} else {
    console.log('please provide valid periscope .m3u8 vod link');
}

function periscope_vod_downloader(g_m3u_url) {
    var g_TEMP = '/temp/',
        g_DOWNLOAD_DIR = './',
        g_fileName = 'outputFile',
        g_simultaneous_down = 20, //number of chunks to download at once.
        g_allChunks = [],
        g_allChunksToDownload = [],
        g_readyToAppend = [],
        g_retry = 70, //on errors, retry this many times
        g_timeToRetry = 20,
        g_retrying = false,
        g_counter = 0,
        g_cookies = '';

    get_M3u(g_m3u_url);

    function request_options(justurl) {
        var options = {
            hostname: url.parse(justurl).hostname,
            path: url.parse(justurl).path,
        }
        g_cookies ? options.headers = {
            'cookie': g_cookies,
            'User-Agent': 'Mozilla/5.0 (Windows NT 6.3; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.103 Safari/537.36'// It makes no differnce if I add it or not.(?)
        } : ''; //if cookies, add them to request options.
        return options;
    }

    function get_M3u(m3u_url) {
        var options = request_options(m3u_url);

        https.get(options, function (res) {
            var responseParts = [];
            res.setEncoding('utf8');
            res.on('data', function (dataChunk) {
                responseParts.push(dataChunk);
            });
            res.on('end', function () {
                var m3u_response = responseParts.join(''); //complete m3u text
                // console.log(m3u_response);
                var availableStreamsURLs = [];
                if (m3u_response.indexOf('#EXT-X-PLAYLIST-TYPE:VOD') !== -1) {
                    g_allChunks = m3u_response.split('\n').filter(function (line) { //list of video chunks from m3u8 playlist.
                        return /^chunk_.+/gm.test(line);
                    });
                    mk_Temp();
                } else if (m3u_response.indexOf('#EXT-X-STREAM-INF') !== -1) {
                    availableStreamsURLs = m3u_response.split('\n').filter(function (line) { //list of available streams.
                        return /^\/.+/gm.test(line);
                    });
                    var bestQualUrl = url.resolve('https://' + url.parse(m3u_url).host + '/', availableStreamsURLs[availableStreamsURLs.length - 1])
                    get_M3u(bestQualUrl)
                } else if (res.statusCode === 301) { //private vod redirection link
                    var prvCookies = res.headers['set-cookie'];
                    g_m3u_url = res.headers['location'];
                    for (var cookie in prvCookies) {
                        cookie = (prvCookies[cookie] + "").split(/\s/).shift(); //get first element for each cookie, splited by " ".
                        g_cookies += cookie;
                    }
                    get_M3u(g_m3u_url);
                    // cos2(g_m3u_url);
                } else if (m3u_response.indexOf('#EXTM3U') !== -1){ // live
                    console.log('Live broadcasts are not supported yet.');
                } else {
                    console.log(m3u_response);
                }
            });
        }).on('error', function (e) {
            console.error('Error when trying to get m3u file. \n', e);
        });
    }

    function mk_Temp() {
        fs.mkdir(g_DOWNLOAD_DIR + g_TEMP, function (err) {
            if (err) {
                if (err.code == 'EEXIST') existing_chunks_checker(); // ignore the error if the folder already exists
                else throw err; // something else went wrong
            } else existing_chunks_checker(); // successfully created folder
        });
    }

    function prepare_to_download(vid_chunks) {
        g_retrying = false;
        var chunksToDownload = [];
        var chunkUrl = [];
        g_allChunksToDownload = vid_chunks;
        g_allChunksToDownload.length < g_simultaneous_down ? g_simultaneous_down = g_allChunksToDownload.length : '';
        for (var i = 0; i < g_simultaneous_down; i++) {
            chunkUrl[i] = url.resolve(g_m3u_url, g_allChunksToDownload[i]); //replace /playlist.m3u8 with /chunk_i.ts in url to get chunk url.
            chunksToDownload.push(g_allChunksToDownload[i]);
            download_file_httpsget(chunkUrl[i], g_allChunksToDownload[i], chunksToDownload);
        }
    }

    function download_file_httpsget(file_url, chunk_name, chunksToDownload) {
        var options = request_options(file_url);
        var file = fs.createWriteStream(g_DOWNLOAD_DIR + g_TEMP + chunk_name);
        https.get(options, function (res) {
            if ((res.statusCode !== 200) && (g_retry > 0)) { //video chunk might be incomplete/empty. retry.
                g_retry -= 1;
                console.log('statusCode:', res.statusCode);
                setTimeout(function (file_url, chunk_name, chunksToDownload) {
                    download_file_httpsget.bind(null, file_url, chunk_name, chunksToDownload)
                }, 1000);
            } else {
                res.on('data', function (data) {
                    file.write(data);
                }).on('end', function () {
                    file.end();
                    g_readyToAppend.push(chunk_name); //add to list of downloaded video chunks for concatenation
                    g_allChunksToDownload.shift()
                    g_counter += 1;
                    if (g_counter === chunksToDownload.length) {
                        console.log('/////// ' + g_readyToAppend.length + ' / ' + g_allChunks.length + ' ///////');
                        g_counter = 0;
                        prepare_to_download(g_allChunksToDownload);
                        if (g_readyToAppend.length >= g_allChunks.length) {
                            concat_del_Chunks();
                        }
                    }
                });
            }
        }).on('error', function (e) {
            console.error('download file error: ', e);
            if (g_retry > 0) {
                retry_downloading(e);
            }
        });
    };

    function retry_downloading(e) {
        if (!g_retrying) { //when multiple get requests fail, allow only one restart
            g_retrying = true;
            if (e.code === 'ECONNRESET') { //probably reached bandwidth quota, periscope ain't gonna let you download more for some time.
                g_timeToRetry = 120; //wait longer.
            } else g_timeToRetry = 20;
            g_retry -= 1;
            setTimeout(prepare_to_download.bind(null, g_allChunksToDownload), g_timeToRetry * 1000);
        }
    }

    // when downloading of VOD was somehow interrupted, this will check which video chunks were downloaded to prevent unnecessary redownloading. 
    function existing_chunks_checker() {
        console.log('Checking files.');
        var to_download_list = []
        var filesChecked = 0;
        var existingFiles = 0;
        var requestsChecked = 0;
        g_allChunks.forEach(function (videoChunk) { //checking existance and size of dowloaded video chunks.
            fs.stat(g_DOWNLOAD_DIR + g_TEMP + videoChunk, function (err, stats) {
                if (stats) { // chunk downloaded already
                    existingFiles += 1;
                    filesChecked += 1;
                    request_file_size(videoChunk, stats.size)
                } else { // does not exist, download this chunk
                    filesChecked += 1
                    to_download_list.push(videoChunk)
                    if ((filesChecked === g_allChunks.length) && !existingFiles) {
                        prepare_to_download(to_download_list);
                    }
                }
            });
        })

        function request_file_size(videoChunk, fileSize) { //comparing file size on disk to content length from header.
            var chunkUrl = url.resolve(g_m3u_url, videoChunk);
            var options = {
                hostname: url.parse(chunkUrl).hostname,
                path: url.parse(chunkUrl).path,
                method: 'HEAD'
            };
            g_cookies ? options.headers = {
                'cookie': g_cookies,
                'User-Agent': 'Mozilla/5.0 (Windows NT 6.3; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/55.0.2883.103 Safari/537.36'
            } : ''; //if cookies, add them to request options.
            var req = https.request(options, function (res) {
                requestsChecked += 1;
                if (res.headers["content-length"] == fileSize) { // correct filesize, no need to redownload.
                    g_readyToAppend.push(videoChunk)
                } else { //                                      // incomplete file, redownload
                    to_download_list.push(videoChunk)
                }
                if ((filesChecked === g_allChunks.length) && (requestsChecked === existingFiles)) {
                    console.log('verified size of '+requestsChecked + ' file(s), '+ g_readyToAppend.length +' is/are OK.');
                    if (to_download_list.length) {
                        prepare_to_download(to_download_list);
                    } else {
                        concat_del_Chunks();
                    }
                }
            });
            req.end();
            req.on('error', function (e) {
                console.error('problem with size checking request:', e);
                requestsChecked += 1; //when problems with checking files online add to download list.
                to_download_list.push(videoChunk)
                if ((filesChecked === g_allChunks.length) && (requestsChecked === existingFiles)) {
                    console.log('verified size of '+requestsChecked + ' file(s), '+ g_readyToAppend.length +' is/are OK.');
                    if (to_download_list.length) {
                        prepare_to_download(to_download_list);
                    } else {
                        concat_del_Chunks();
                    }
                }
            });
        }

    }

    function concat_del_Chunks() {
        var i = 0;
        output_name_check();
        concatRecur(i);
        function concatRecur(i) {
            if (i === g_allChunks.length) { //finished concatenating
                g_allChunks.forEach(function (item_to_del) { //delete all video chunks
                    fs.unlink(g_DOWNLOAD_DIR + g_TEMP + item_to_del, function (err) {
                        if (err) console.error(err);
                    });
                });
                console.log('File saved as: ' + 'R_' + g_fileName + '.ts');
            } else {
                fs.readFile(g_DOWNLOAD_DIR + g_TEMP + g_allChunks[i], {
                    encoding: "binary"
                }, function (err, data) {
                    if (err) throw err;
                    fs.appendFile(g_DOWNLOAD_DIR + 'R_' + g_fileName + '.ts', data, {
                        encoding: "binary"
                    }, function (err) {
                        if (err !== null ? err.code == 'EBUSY' : false) { //if EBUSY ignore it and try again
                            concatRecur(i);
                        } else {
                            if (err) throw err;
                            i += 1;
                            concatRecur(i);
                        }
                    })
                });
            }
        }
    }

    function output_name_check(num) { //apprend +1 @filename end if duplicate, without it output video would just append to previous output vodeo file.
        var x = num || 0;
        fs.stat(g_DOWNLOAD_DIR + 'R_' + g_fileName + (num ? num : '') + '.ts', function (err, stats) {
            if (stats) {
                x += 1;
                output_name_check(x);
            } else {
                num ? g_fileName = g_fileName + num : '';
            }
        });
    }
}