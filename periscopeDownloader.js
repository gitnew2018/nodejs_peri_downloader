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
        g_simultaneous_down = 50, //number of chunks to download at once.
        g_allChunks = [],
        g_allChunksToDownload = [],
        g_readyToAppend = [],
        g_retry = 50, //on errors, retry this many times
        g_timeToRetry = 20,
        g_retrying = false,
        g_counter = 0;

    getM3u(g_m3u_url);

    function getM3u(m3u_url) {
        https.get(m3u_url, function (res) {
            var responseParts = [];
            res.setEncoding('utf8');
            res.on('data', function (dataChunk) {
                responseParts.push(dataChunk);
            });
            res.on('end', function () {
                var m3u_response = responseParts.join(''); //complete m3u text
                var availableStreamsURLs = [];
                if (m3u_response.indexOf('#EXT-X-PLAYLIST-TYPE:VOD') !== -1) {
                    g_allChunks = m3u_response.split('\n').filter(function (line) { //list of video chunks from m3u8 playlist.
                        return /^chunk_.+/gm.test(line);
                    });
                    outputNameCheck();
                    mkTemp();
                } else if (m3u_response.indexOf('#EXT-X-STREAM-INF') !== -1) {
                    availableStreamsURLs = m3u_response.split('\n').filter(function (line) { //list of available streams.
                        return /^\/.+/gm.test(line);
                    });
                    var bestQualUrl = url.resolve('https://' + url.parse(m3u_url).host + '/', availableStreamsURLs[availableStreamsURLs.length - 1])
                    getM3u(bestQualUrl)
                } else if (m3u_response.indexOf('#EXTM3U') !== -1); //live
                else console.log(m3u_response);
            });
        }).on('error', function (e) {
            console.error('Error when trying to get m3u file. \n', e);
        });
    }

    function mkTemp() {
        fs.mkdir(g_DOWNLOAD_DIR + g_TEMP, function (err) {
            if (err) {
                if (err.code == 'EEXIST') downloaded_chechker(); // ignore the error if the folder already exists
                else throw err; // something else went wrong
            } else downloaded_chechker(); // successfully created folder
        });
    }

    function prepare_to_download(vid_chunks) {
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
        var file = fs.createWriteStream(g_DOWNLOAD_DIR + g_TEMP + chunk_name);
        https.get(file_url, function (res) {
            if ((res.statusCode !== 200) && (g_retry > 0)) { //video chunk might be incomplete/empty. retry.
                g_retry -= 1;
                setTimeout(function (file_url, chunk_name, chunksToDownload) {
                    download_file_httpsget.bind(null, file_url, chunk_name, chunksToDownload)
                }, 2000);
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
                            downloaded_chechker();
                        }
                    }
                });
            }
        }).on('error', function (e) {
            console.error('download file error:', e);
            if (g_retry > 0) {
                prepare_to_download(g_allChunksToDownload);
            }
        });
    };

    function retryDownloading(e) {
        if (!g_retrying) { //when multiple get requests fail, allow only one restart
            if (e.code === 'ECONNRESET') {//probably reached bandwidth quota, periscope ain't gonna let you download more for some time.
                g_timeToRetry = 120; //wait 2 mins
            }else g_timeToRetry = 20;
            g_retry -= 1;
            g_retrying = true;
            setTimeout(downloaded_chechker, g_timeToRetry*1000);
        }
    }

    function downloaded_chechker() {
        console.log('Checking files.');
        var to_download_list = [];
        var files_checked = 0;
        g_allChunks.forEach(function (chunk_m3u) {
            fs.stat(g_DOWNLOAD_DIR + g_TEMP + chunk_m3u, function (err, stats) {
                if (stats) { // chunk downloaded already
                    stats.size ? '' : to_download_list.push(chunk_m3u); // if file is 0 bytes, add to download list
                    g_readyToAppend.push(chunk_m3u);
                    files_checked += 1;
                    if (files_checked === g_allChunks.length) {
                        if (to_download_list.length) {
                            console.log('Checking files complete. ', g_readyToAppend.);
                            g_retrying = false;
                            redownload_last_few(to_download_list)
                        } else {
                            console.log('Checking files complete.');
                            console.log('Concatenating.');
                            concat_del_Chunks();
                        }
                    }
                } else { // download this chunk
                    files_checked += 1;
                    to_download_list.push(chunk_m3u);
                    if (files_checked === g_allChunks.length) {
                        console.log('Checking files complete');
                        g_retrying = false;
                        redownload_last_few(to_download_list);
                    }
                }
            });
        });

        function redownload_last_few(to_download_list) {
            for (var i = 0; i < g_simultaneous_down; i++) {
                if (g_readyToAppend.length > 0) {
                    to_download_list.unshift(g_readyToAppend.pop());
                }
            }
            prepare_to_download(to_download_list);
        }
    }

    function concat_del_Chunks() {
        var i = 0;
        concatRecur(i);
        function concatRecur(i) {
            if (i === g_allChunks.length) { //finished concatenating
                g_allChunks.forEach(function (item_to_del) { //delete all video chunks
                    fs.unlink(g_DOWNLOAD_DIR + g_TEMP + item_to_del, function (err) {
                        if (err) console.error(err);
                    });
                });
                console.log('File saved as: ' + g_fileName + '.ts');
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

    function outputNameCheck(num) { //without it output would just append to previous output file.
        var x = num || 0;
        fs.stat(g_DOWNLOAD_DIR + 'R_' + g_fileName + (num ? num : '') + '.ts', function (err, stats) {
            if (stats) {
                x += 1;
                outputNameCheck(x);
            } else {
                num ? g_fileName = g_fileName + num : '';
            }
        });
    }
}