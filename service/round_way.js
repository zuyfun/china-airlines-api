const axios = require('axios');
const cheerio = require('cheerio');
const e = require('express');
const qs = require('qs');
const moment = require('moment');
const Flight = require('../model/flight.js');
const BookingClass = require('../model/booking_class.js');
const cookie = require('cookie');
const SOLD_OUT = { "error": true, "msg": "FNF" }
const ERROR = { "error": true, "msg": "<ERROR_MESSAGE>" }
const redisClient = require('../config/redisClient');

async function one_way_process(req) {
    const cookieIndex =  Math.floor(Math.random() * 5) + 1;
    const searchForm = await create_search_form(req, cookieIndex);
    if (searchForm.length == 0) {
        return SOLD_OUT;
    } else {
        return await get_flight_info(req, searchForm,cookieIndex);
    }
}
async function create_search_form(req,cookieIndex) {
    /**
   {
    "origin": "LGK",
    "dest": "KUL",
    "adult": 2,
    "child": 0,
    "infant": 0,
    "dptDate": "2021-09-29",
    "rtnDate": "2021-09-30",
    "dptFlightCode" : "AK123", // no require
    "dptTrsFlightCode": "AK456" // no require
    }
   */
    const body = req.body;
    const dptDate = body.dptDate.split("-").join("") + '0000';
    const rtnDate = body.rtnDate.split("-").join("") + '0000';
    let data = `B_LOCATION_1=${body.origin}&E_LOCATION_1=${body.dest}&B_DATE_1=${dptDate}&B_LOCATION_2=${body.dest}&E_LOCATION_2=${body.origin}&B_DATE_2=${rtnDate}&ADULTS=${body.adult}&CHILDS=${body.child}&INFANTS=${body.infant}&LANG=GB&CABIN=Y&TRIP_TYPE=R&Channel=IOS&EBA=GB`;
    let cookie = await getCookieFromRedis(cookieIndex);
    let config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: 'https://bookingportal.china-airlines.com/eRetailPortal/Mobile.svc/Mobile/Search',
        headers: {
            'Host': 'bookingportal.china-airlines.com',
            'Sec-Fetch-Site': 'none',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'Sec-Fetch-Mode': 'navigate',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Origin': 'null',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
            'Sec-Fetch-Dest': 'document',
            'Content-Type': 'text/plain',
            'Cookie': cookie
        },
        data: data
    };
    const searchResponse = await fetchData(config);
    const $ = cheerio.load(searchResponse.data);
    const inputElements = $('input');
    const inputData = [];
    inputElements.each((index, element) => {
        const name = $(element).attr('name');
        const value = $(element).val();
        inputData.push({ name, value });
        inputData.push({ name, value });
    });
    return inputData;
}
async function get_flight_info(req, searchForms,cookieIndex) {
    const dptMap = new Map();
    const rtnMap = new Map();
    const dpt = new Array();
    const rtn = new Array();
    // let data = qs.stringify({
    //   'EMBEDDED_TRANSACTION': '',
    //   'ENC': '',
    //   'ENCT': '',
    //   'SITE': '',
    //   'LANGUAGE': '' 
    // });
    const searchData = {};
    searchForms.forEach(element => {
        searchData[element.name] = element.value;
    });
    const data = qs.stringify(searchData)
    let cookie = await getCookieFromRedis(cookieIndex);
    let config = {
        method: 'post',
        maxBodyLength: Infinity,
        url: 'https://book.china-airlines.com/plnext/FPChinaAirlines/Override.action',
        headers: {
            'Host': 'book.china-airlines.com',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'Sec-Fetch-Site': 'same-site',
            'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
            'Sec-Fetch-Mode': 'navigate',
            'Origin': 'https://bookingportal.china-airlines.com',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_1_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
            'Referer': 'https://bookingportal.china-airlines.com/',
            'Sec-Fetch-Dest': 'document',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Cookie': cookie
        },
        data: data
    };
    if (cookie !== undefined && cookie !== null) {
        console.log(`Has cookie ${cookieIndex}`)
    }else {
        console.log('Has no cookie')
    }
    const searchResponse = await fetchData(config);
    if (searchResponse.data === null || searchResponse.data === undefined) {
        console.log('No response')
        return SOLD_OUT
    }    const pattern = /{"siteConfiguration"\s*:\s*{[^]*}}}/g;
    const cleanedData = searchResponse.data.replace(/\r?\n|\r/g, '');
    const matches = cleanedData.match(pattern);
    const jsonObject = JSON.parse(matches);
    if (jsonObject === null) {
        console.log(`Cookie ${cookieIndex} expried`);
        return SOLD_OUT;
    }
    const availability = jsonObject.pageDefinitionConfig.pageData.business.Availability;
    if (availability === undefined) {
        console.log(`Cookie ${cookieIndex} expried`)
        return SOLD_OUT;
    }
    const recommendationList = availability.recommendationList;
    const proposedBounds = availability.proposedBounds;
    const dptFlights = proposedBounds[0].proposedFlightsGroup
    const rtnFlights = proposedBounds[1].proposedFlightsGroup
    for (flightIndex in dptFlights) {
        const flightObject = new Flight();
        const recomendList = recommendationList.filter(recommendation => recommendation.bounds[0].flightGroupList.find(flight => flight.flightId === dptFlights[flightIndex].proposedBoundId))
        const recomend = recomendList.reduce((smallestObj, currentObj) => {
            if (!smallestObj || currentObj.bounds[0].travellerPrices.ADT < smallestObj.bounds[0].travellerPrices.ADT) {
              return currentObj;
            }
            return smallestObj;
          }, null);
        const dptSegments = dptFlights[flightIndex].segments;
        if(dptSegments.length>2) continue;
        const flight = recomend.bounds[0].flightGroupList.find(flight => flight.flightId === dptFlights[flightIndex].proposedBoundId);
        if(flight === undefined || flight ===null) continue;
        const bookingClass = CLASS_MAP.get(flight.rbd)
        // console.log(bookingClass)
        const dptTravellerPrices = {
            ADT: recomend.bounds[0].travellerPrices.ADT,
            CHD: recomend.bounds[0].travellerPrices.CHD,
            INF: recomend.bounds[0].travellerPrices.INF
        }
        let dptDepartDateTime = null;
            let dptArrivalDateTime = null;
            let dptTransitDepartDateTime = null;
            let dptTransitArrivalDateTime = null;
            let dptDepartTerminal = null;
            let dptArrivalTerminal = null;
            let dptTransitDepartTerminal = null;
            let dptTransitArrivalTerminal = null;
        if (dptSegments.length == 2) {
            dptDepartDateTime = moment(dptSegments[0].beginDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            dptArrivalDateTime = moment(dptSegments[1].endDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            dptTransitDepartDateTime = moment(dptSegments[1].beginDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            dptTransitArrivalDateTime = moment(dptSegments[0].endDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            dptDepartTerminal = dptSegments[0].beginTerminal;
            dptArrivalTerminal = dptSegments[1].endTerminal;
            dptTransitDepartTerminal = dptSegments[1].beginTerminal;
            dptTransitArrivalTerminal = dptSegments[0].endTerminal;
        }
        // if (!dptFlightMap.has('' + flightObject._flightCode + flightObject._transitFlightCode)) {

        // if (req.body.dptFlightCode !== null && req.body.dptFlightCode !== undefined) {
        //     if (req.body.dptFlightCode !== (dptSegments[0].airline.code + dptSegments[0].flightNumber)) {
        //         continue;
        //     }
        // }
        // if (req.body.dptTrsFlightCode !== null && req.body.dptTrsFlightCode !== undefined) {
        //     if (req.body.dptTrsFlightCode !== (dptSegments[1].airline.code + dptSegments[1].flightNumber)) {
        //         continue;
        //     }
        // }
        if (dptSegments.length < 2) {
            const segment = dptSegments[0];
            flightObject.flightCode = segment.airline.code + segment.flightNumber;
            flightObject.type = 'direct'
            flightObject.departTerminal = segment.beginTerminal;
            flightObject.departDateTime = moment(segment.beginDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            flightObject.arrivalTerminal = segment.endTerminal;
            flightObject.arrivalDateTime = moment(segment.endDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            flightObject.cabinClass = bookingClass._cabinClass;
            flightObject.bookingClass = flight.rbd;
            flightObject.class = flight.rbd;
            flightObject.currency = availability.currencyBean.code;
            flightObject.aircraftName = segment.equipment.name;
            flightObject.aircraftIata = segment.equipment.code;
            let match = segment.equipment.name.match(/ [^]*-/g)
            if (match !== null) {
                flightObject.aircraftIcao = match[0].slice(1, -1);
            } else {
                match = segment.equipment.name.match(/ [^]*/g);
                if (match !== null) {
                    flightObject.aircraftIcao = match[0].slice(1);
                }
            }
            flightObject.operatingAirline = segment.opAirline.name
            flightObject.priceAdult = (dptTravellerPrices.ADT === undefined) ? 0 : dptTravellerPrices.ADT;
            flightObject.priceChild = (dptTravellerPrices.CHD === undefined) ? 0 : dptTravellerPrices.CHD;
            flightObject.priceInfant = (dptTravellerPrices.INF === undefined) ? 0 : dptTravellerPrices.INF;
        }else{
            dptSegments.forEach(segment => {
                if (segment.endLocation.locationCode !== req.body.dest) {
                    flightObject.flightCode = segment.airline.code + segment.flightNumber;
                    flightObject.type = 'direct'
                    flightObject.departTerminal = segment.beginTerminal;
                    flightObject.departDateTime = moment(segment.beginDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
                    flightObject.arrivalTerminal = segment.endTerminal;
                    flightObject.arrivalDateTime = moment(segment.endDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
                    flightObject.cabinClass = bookingClass._cabinClass;
                    flightObject.bookingClass = flight.rbd;
                    flightObject.class = flight.rbd;
                    flightObject.currency = availability.currencyBean.code;
                    flightObject.aircraftName = segment.equipment.name;
                    flightObject.aircraftIata = segment.equipment.code;
                    let match = segment.equipment.name.match(/ [^]*-/g)
                    if (match !== null) {
                        flightObject.aircraftIcao = match[0].slice(1, -1);
                    } else {
                        match = segment.equipment.name.match(/ [^]*/g);
                        if (match !== null) {
                            flightObject.aircraftIcao = match[0].slice(1);
                        }
                    }
                    flightObject.operatingAirline = segment.opAirline.name
                    flightObject.priceAdult = (dptTravellerPrices.ADT === undefined) ? 0 : dptTravellerPrices.ADT;
                    flightObject.priceChild = (dptTravellerPrices.CHD === undefined) ? 0 : dptTravellerPrices.CHD;
                    flightObject.priceInfant = (dptTravellerPrices.INF === undefined) ? 0 : dptTravellerPrices.INF;
                } else {
                    flightObject.type = 'transit'
                    flightObject.transitFlightCode = segment.airline.code + segment.flightNumber;
                    flightObject.transitDepartTerminal = dptTransitDepartTerminal
                    flightObject.transitArrivalTerminal = dptTransitArrivalTerminal
                    flightObject.departTerminal = dptDepartTerminal;
                    flightObject.arrivalTerminal = dptArrivalTerminal;
                    flightObject.transitAirport = segment.beginLocation.locationCode;
                    flightObject.departDateTime = dptDepartDateTime;
                    flightObject.arrivalDateTime = dptArrivalDateTime
                    flightObject.transitDepartDateTime = dptTransitDepartDateTime
                    flightObject.transitArrivalDateTime = dptTransitArrivalDateTime
                    flightObject.transitOperatingAirline = segment.opAirline.name
                }
            });
        }

        if (!dptMap.has('' + flightObject._flightCode + flightObject._transitFlightCode)) {
            dpt.push(flightObject.toJson())
            dptMap.set('' + flightObject._flightCode + flightObject._transitFlightCode)
        }
    }
    for (flightIndex in rtnFlights) {
        const flightObject = new Flight();
        const recomendList = recommendationList.filter(recommendation => recommendation.bounds[1].flightGroupList.find(flight => flight.flightId === rtnFlights[flightIndex].proposedBoundId))
        const recomend = recomendList.reduce((smallestObj, currentObj) => {
            if (!smallestObj || currentObj.bounds[1].travellerPrices.ADT < smallestObj.bounds[1].travellerPrices.ADT) {
              return currentObj;
            }
            return smallestObj;
          }, null);
        const rtnSegments = rtnFlights[flightIndex].segments;
        if(rtnSegments.length>2) continue;
        if(recomend === undefined || recomend === null){
            continue;
        }
        const flight = recomend.bounds[1].flightGroupList.find(flight => flight.flightId === rtnFlights[flightIndex].proposedBoundId);
        if(flight === undefined || flight ===null) continue;
        const bookingClass = CLASS_MAP.get(flight.rbd)
        // console.log(bookingClass)
        const rtnTravellerPrices = {
            ADT: recomend.bounds[1].travellerPrices.ADT,
            CHD: recomend.bounds[1].travellerPrices.CHD,
            INF: recomend.bounds[1].travellerPrices.INF
        }
        let rtnDepartDateTime = null;
            let rtnArrivalDateTime = null;
            let rtnTransitDepartDateTime = null;
            let rtnTransitArrivalDateTime = null;
            let rtnDepartTerminal = null;
            let rtnArrivalTerminal = null;
            let rtnTransitDepartTerminal = null;
            let rtnTransitArrivalTerminal = null;
        if (rtnSegments.length == 2) {
            rtnDepartDateTime = moment(rtnSegments[0].beginDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            rtnArrivalDateTime = moment(rtnSegments[1].endDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            rtnTransitDepartDateTime = moment(rtnSegments[1].beginDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            rtnTransitArrivalDateTime = moment(rtnSegments[0].endDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            rtnDepartTerminal = rtnSegments[0].beginTerminal;
            rtnArrivalTerminal = rtnSegments[1].endTerminal;
            rtnTransitDepartTerminal = rtnSegments[1].beginTerminal;
            rtnTransitArrivalTerminal = rtnSegments[0].endTerminal;
        }
        if (rtnSegments.length < 2) {
            segment = rtnSegments[0];
            flightObject.flightCode = segment.airline.code + segment.flightNumber;
            flightObject.type = 'direct'
            flightObject.departTerminal = segment.beginTerminal;
            flightObject.departDateTime = moment(segment.beginDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            flightObject.arrivalTerminal = segment.endTerminal;
            flightObject.arrivalDateTime = moment(segment.endDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
            flightObject.cabinClass = bookingClass._cabinClass;
            flightObject.bookingClass = flight.rbd;
            flightObject.class = flight.rbd;
            flightObject.currency = availability.currencyBean.code;
            flightObject.aircraftName = segment.equipment.name;
            flightObject.aircraftIata = segment.equipment.code;
            let match = segment.equipment.name.match(/ [^]*-/g)
            if (match !== null) {
                flightObject.aircraftIcao = match[0].slice(1, -1);
            } else {
                match = segment.equipment.name.match(/ [^]*/g);
                if (match !== null) {
                    flightObject.aircraftIcao = match[0].slice(1);
                }
            }
            flightObject.operatingAirline = segment.opAirline.name
            flightObject.priceAdult = (rtnTravellerPrices.ADT === undefined) ? 0 : rtnTravellerPrices.ADT;
            flightObject.priceChild = (rtnTravellerPrices.CHD === undefined) ? 0 : rtnTravellerPrices.CHD;
            flightObject.priceInfant = (rtnTravellerPrices.INF === undefined) ? 0 : rtnTravellerPrices.INF;
        }else{
            rtnSegments.forEach(segment => {
                if (segment.endLocation.locationCode !== req.body.origin) {
                    flightObject.flightCode = segment.airline.code + segment.flightNumber;
                    flightObject.type = 'direct'
                    flightObject.departTerminal = segment.beginTerminal;
                    flightObject.departDateTime = moment(segment.beginDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
                    flightObject.arrivalTerminal = segment.endTerminal;
                    flightObject.arrivalDateTime = moment(segment.endDate, 'MMMM DD, YYYY h:mm:ss A').format('YYYY-MM-DD HH:mm:ss');
                    flightObject.cabinClass = bookingClass._cabinClass;
                    flightObject.bookingClass = flight.rbd;
                    flightObject.class = flight.rbd;
                    flightObject.currency = availability.currencyBean.code;
                    flightObject.aircraftName = segment.equipment.name;
                    flightObject.aircraftIata = segment.equipment.code;
                    let match = segment.equipment.name.match(/ [^]*-/g)
                    if (match !== null) {
                        flightObject.aircraftIcao = match[0].slice(1, -1);
                    } else {
                        match = segment.equipment.name.match(/ [^]*/g);
                        if (match !== null) {
                            flightObject.aircraftIcao = match[0].slice(1);
                        }
                    }
                    flightObject.operatingAirline = segment.opAirline.name
                    flightObject.priceAdult = (rtnTravellerPrices.ADT === undefined) ? 0 : rtnTravellerPrices.ADT;
                    flightObject.priceChild = (rtnTravellerPrices.CHD === undefined) ? 0 : rtnTravellerPrices.CHD;
                    flightObject.priceInfant = (rtnTravellerPrices.INF === undefined) ? 0 : rtnTravellerPrices.INF;
                } else {
                    flightObject.type = 'transit'
                    flightObject.transitFlightCode = segment.airline.code + segment.flightNumber;
                    flightObject.transitDepartTerminal = rtnTransitDepartTerminal
                    flightObject.transitArrivalTerminal = rtnTransitArrivalTerminal
                    flightObject.departTerminal = rtnDepartTerminal;
                    flightObject.arrivalTerminal = rtnArrivalTerminal;
                    flightObject.transitAirport = segment.beginLocation.locationCode;
                    flightObject.departDateTime = rtnDepartDateTime;
                    flightObject.arrivalDateTime = rtnArrivalDateTime
                    flightObject.transitDepartDateTime = rtnTransitDepartDateTime
                    flightObject.transitArrivalDateTime = rtnTransitArrivalDateTime
                    flightObject.transitOperatingAirline = segment.opAirline.name
                }
            });
        }
        if (!rtnMap.has('' + flightObject._flightCode + flightObject._transitFlightCode)) {
            rtn.push(flightObject.toJson())
            rtnMap.set('' + flightObject._flightCode + flightObject._transitFlightCode)
        }
    }
    const res = {
        "dpt": dpt,
        "rtn": rtn
    };
    return res;
}

function fetchData(config) {
    return axios.request(config)
        .then((response) => {
            return response;
        })
        .catch((error) => {
            return error;
        });
}
async function getCookieVariable(cookieString, variableName) {
    const cookies = cookie.parse(cookieString);

    if (cookies && cookies[variableName]) {
        return cookies[variableName];
    } else {
        return null;
    }
}
async function getCookieFromRedis(cookieIndex) {
    const redisValue = await redisClient.get(`farelive-chinaairlines-auth-${cookieIndex}`);
    const redisJson = await JSON.parse(redisValue);
    return redisJson.token;
}
const ecoBasic = new BookingClass('VNSHECB', 'ECO Basic', 'ECO');
const ecoStandard = new BookingClass('VNSHECS', 'ECO Standard', 'ECO');
const ecoFlex = new BookingClass('VNSHECF', 'ECO Flex ', 'ECO');
const businessBasic = new BookingClass('VNSHBZB', 'Business Basic', 'BIZ');
const businessStandard = new BookingClass('VNSHBZS', 'Business Standard', 'BIZ');
const businessFlex = new BookingClass('VNSHBZF', 'Business Flex', 'BIZ');
const CLASS_MAP = new Map([
    { key: 'N', value: ecoBasic },
    { key: 'Q', value: ecoBasic },
    { key: 'H', value: ecoBasic },
    { key: 'R', value: ecoBasic },
    { key: 'K', value: ecoStandard },
    { key: 'V', value: ecoStandard },
    { key: 'T', value: ecoStandard },
    { key: 'Y', value: ecoFlex },
    { key: 'B', value: ecoFlex },
    { key: 'M', value: ecoFlex },
    { key: 'D', value: businessBasic },
    { key: 'C', value: businessStandard },
    { key: 'J', value: businessFlex },
].map(obj => [obj.key, obj.value]));
module.exports = one_way_process;


/// VNSHECB: ECO Basic - R/Q/H/N
/// VNSHBZF: Business Flex - J
/// VNSHBZB: Business Basic - D
/// VNSHBZS: Business Standard - C
/// VNSHECS: ECO Standard - K/V/T
/// VNSHECF: ECO Flex - Y/B/M
/// ECO Discount L