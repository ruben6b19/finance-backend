export const validateImage = /^[a-zA-Z0-9]{0,20}$/;
export const validateChat = /^[/:#()*'\"-.,;?¿!¡a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]{1,100}$/;
export const validateDecimalRadius = /^([0-9]{1,2})([.][0-9]{2,9})$/;//solo admin
export const validateDecimal = /^([0-9]{1,3})([.][0-9]{2})?$/;
export const validateDecimalForPrice = /^([0-9]{1,5})([.][0-9]{1,12})?$/;
export const validateSchedule = /^([01]?[0-9]|2[0-3]):[0-5][0-9](,([01]?[0-9]|2[0-3]):[0-5][0-9])?$/;
export const validateCreated = /^[0-9]{10}$/;
export const validateUpdated = /^([0]{1})|([0-9]{10})$/;
export const maxStatus = 2;
export const minStatus = 0;
export const validateNameAddress = /^[/:#()*'\"-.,;?¿!¡a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]{0,50}$/;
export const validateDescriptionAddress = /^[/:#()*'\"-.,;?¿!¡a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]{0,150}$/;
export const validateLatitude=/^([-]?[0-9]{1,3})([.][0-9]{2,15})$/;//no funciona el maximo 3 13 pero si el minimo 
export const validateLongitude=/^([-]?[0-9]{1,3})([.][0-9]{2,15})$/;
export const maxTimestamp = 2147483647;


export const validateEmail = /^[a-zA-Z0-9._%+-]{1,64}@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$/i;
export const validateName = /^[-'a-zA-ZñÑáéíóúÁÉÍÓÚ ]{2,50}$/;
export const validateNumber = /^[/:.,-;0-9 ]{1,50}$/;
export const validateNumberOfOneDigit = /^[0-9]{1}$/;
export const validateYear = /^[/0-9 ]{4}$/;
export const validateText = /^[/:#()*'"-.,;?¿!¡a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]{0,400}$/;
export const validateShortName = /^[/:#()*'"-.,;?¿!¡A-ZÑÁÉÍÓÚ0-9 ]{2}$/;
export const validatePlaque = /^[0-9]{3,4}[A-Z]{3}$/;
export const validateSearch = /^[/:#()*'"-.,;?¿!¡a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]{1,30}$/;
export const validateDescription = /^[/:#()*'"-.,;?¿!¡a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]{0,500}$/;
// Permite letras, números, espacios, signos de puntuación comunes y caracteres de etiquetas HTML (<, >, /, =)
export const validateRichText = /^[<>/="':#()*&;,\-.\s?¿!¡a-zA-ZñÑáéíóúÁÉÍÓÚ0-9]{0,2000}$/;
export const validateMobile = /^[0-9]{8,10}(,[0-9]{8,10})?$/;
export const validateCi = /^[/()'"-.,;?¿!¡a-zA-ZñÑáéíóúÁÉÍÓÚ0-9 ]{7,10}$/;
export const validatePhone = /^[0-9]{5,10}(,[0-9]{5,10})?$/;
export const validateWebsite = /^((https?|ftp|smtp):\/\/)?(www.)?[a-z0-9]+(\.[a-z]{2,}){1,3}(#?\/?[a-zA-Z0-9#]+)*\/?(\?[a-zA-Z0-9-_]+=[a-zA-Z0-9-%]+&?)?$/;
export const validatePass = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/;

//const validateEmail = /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])&/;

export const validateBarCode = /^[a-zA-Z0-9]{5,20}$/;

export const validateCloudinaryId = /^[a-z0-9]{20,22}$/;
//([01]?[0-9]|2[0-3]):[0-5][0-9]
